import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AnalysisSettingsSchema,
  DEFAULT_PROFILE,
  PROFILE_EXPORT_VERSION,
  defaultAnalysisSettings,
  normalizeGamme,
  type AnalysisSettings,
  type ProfileExport,
  type ProfileMeta,
  type SettingsProfile,
} from '@websentry/shared';
import {
  ProfileRepository,
  type ProfileMetaRow,
  type ProfileRow,
} from '../database/repositories/profile.repository.js';
import { AuditService } from '../audit/audit.service.js';
import {
  DefaultProfileProtectedError,
  ProfileNotFoundError,
  ProfileVersionConflictError,
} from './profile.errors.js';

/** Contexte d'écriture — qui écrit, pour la traçabilité. */
export interface WriteContext {
  actorId: string | null;
  actorName: string;
  ipAddress: string | null;
}

/**
 * Profils de réglages par gamme.
 *
 * Deux invariants tiennent tout le module :
 *
 *   • Le profil `default` existe toujours et n'est jamais supprimable. Il est
 *     le repli quand la gamme n'est pas détectée ; sans lui, une analyse
 *     n'aurait aucun réglage sur lequel s'appuyer.
 *   • Les réglages sont validés par Zod à l'écriture ET à la lecture. La
 *     seconde validation n'est pas redondante : une ligne peut avoir été écrite
 *     par une version antérieure du schéma, ou modifiée directement en base.
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly repo: ProfileRepository,
    private readonly audit: AuditService,
  ) {}

  private assertAvailable(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException('Gestion des profils indisponible');
    }
  }

  /**
   * Normalise une gamme et refuse ce qui n'en laisse rien.
   *
   * « !!! » se normalise en chaîne vide : accepter ce cas créerait un profil
   * sans identifiant, impossible à retrouver ou à supprimer ensuite.
   */
  normalize(raw: string): string {
    const normalized = normalizeGamme(raw);
    if (normalized.length === 0) {
      throw new BadRequestException(
        'Gamme invalide — au moins un caractère alphanumérique est requis',
      );
    }
    return normalized;
  }

  // ── Lecture ───────────────────────────────────────────────────────────────

  async list(): Promise<ProfileMeta[]> {
    this.assertAvailable();
    const rows = await this.repo.list();
    return rows.map(row => this.toMeta(row));
  }

  /** Profil complet. Lève si la gamme n'existe pas. */
  async get(gamme: string): Promise<SettingsProfile> {
    this.assertAvailable();
    const normalized = this.normalize(gamme);
    const row = await this.repo.findByGamme(normalized);
    if (!row) throw new ProfileNotFoundError(normalized);
    return this.toProfile(row);
  }

  /**
   * Réglages applicables à une gamme, avec REPLI sur `default`.
   *
   * C'est le chemin qu'emprunte l'analyse : une gamme inconnue ne doit pas
   * faire échouer un scan, elle doit hériter du profil de repli.
   */
  async resolveSettings(
    gamme: string | null,
  ): Promise<{ profile: string; settings: AnalysisSettings }> {
    this.assertAvailable();

    if (gamme) {
      const normalized = normalizeGamme(gamme);
      if (normalized.length > 0) {
        const row = await this.repo.findByGamme(normalized);
        if (row) return { profile: normalized, settings: this.parseSettings(row) };
      }
    }

    const fallback = await this.repo.findByGamme(DEFAULT_PROFILE);
    if (fallback) return { profile: DEFAULT_PROFILE, settings: this.parseSettings(fallback) };

    // Le profil de repli a disparu de la base : on sert les défauts du schéma
    // plutôt que de faire échouer l'analyse, et on le signale bruyamment.
    this.logger.error(
      'Profil « default » absent de la base — repli sur les valeurs par défaut du schéma',
    );
    return { profile: DEFAULT_PROFILE, settings: defaultAnalysisSettings() };
  }

  // ── Écriture ──────────────────────────────────────────────────────────────

  /**
   * Crée ou met à jour un profil.
   *
   * Le verrouillage optimiste s'applique aux mises à jour : `expectedVersion`
   * absent écrase sans condition, ce qui n'est acceptable que pour une création
   * ou un import explicitement assumé.
   */
  async save(
    gamme: string,
    input: {
      settings: AnalysisSettings;
      label?: string;
      description?: string | null;
      expectedVersion?: number;
    },
    ctx: WriteContext,
  ): Promise<SettingsProfile> {
    this.assertAvailable();
    const normalized = this.normalize(gamme);

    // Re-validation défensive : le pipe a déjà validé la charge utile HTTP, mais
    // ce service est aussi appelé depuis l'import, dont la source est un fichier.
    const settings = AnalysisSettingsSchema.parse(input.settings);

    const existingVersion = await this.repo.currentVersion(normalized);

    if (existingVersion === null) {
      await this.create(normalized, settings, input, ctx);
    } else {
      await this.update(normalized, settings, input, ctx, existingVersion);
    }

    return this.get(normalized);
  }

  private async create(
    gamme: string,
    settings: AnalysisSettings,
    input: { label?: string; description?: string | null },
    ctx: WriteContext,
  ): Promise<void> {
    const created = await this.repo.create(
      gamme,
      input.label ?? this.defaultLabel(gamme),
      input.description ?? null,
      settings,
      ctx.actorName,
    );

    // Course perdue : un autre appelant a créé la gamme entre notre lecture de
    // version et l'insertion. Ce n'est pas une erreur pour l'utilisateur — on
    // bascule sur une mise à jour non conditionnée.
    if (!created) {
      await this.repo.updateWithVersion(
        gamme,
        input.label ?? this.defaultLabel(gamme),
        input.description ?? null,
        settings,
        ctx.actorName,
        null,
      );
    }

    await this.audit.record({
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      action: 'profile.created',
      targetId: null,
      targetType: 'settings_profile',
      details: { gamme },
      ipAddress: ctx.ipAddress,
    });
    this.logger.log(`Profil ${gamme} créé par ${ctx.actorName}`);
  }

  private async update(
    gamme: string,
    settings: AnalysisSettings,
    input: { label?: string; description?: string | null; expectedVersion?: number },
    ctx: WriteContext,
    existingVersion: number,
  ): Promise<void> {
    // Les champs omis conservent leur valeur : une écriture partielle ne doit
    // pas effacer un libellé ou une description qu'on n'a pas voulu toucher.
    const current = await this.repo.findByGamme(gamme);
    const label = input.label ?? current?.label ?? this.defaultLabel(gamme);
    const description =
      input.description !== undefined ? input.description : (current?.description ?? null);

    const updated = await this.repo.updateWithVersion(
      gamme,
      label,
      description,
      settings,
      ctx.actorName,
      input.expectedVersion ?? null,
    );

    if (!updated) {
      // La condition de version n'a touché aucune ligne : quelqu'un a écrit
      // entre la lecture du client et sa soumission.
      const currentVersion = (await this.repo.currentVersion(gamme)) ?? existingVersion;
      throw new ProfileVersionConflictError(gamme, currentVersion, input.expectedVersion ?? -1);
    }

    await this.audit.record({
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      action: 'profile.updated',
      targetId: null,
      targetType: 'settings_profile',
      details: { gamme, fromVersion: existingVersion },
      ipAddress: ctx.ipAddress,
    });
    this.logger.log(`Profil ${gamme} mis à jour par ${ctx.actorName}`);
  }

  /** Supprime un profil. Le repli `default` est protégé. */
  async remove(gamme: string, ctx: WriteContext): Promise<void> {
    this.assertAvailable();
    const normalized = this.normalize(gamme);

    if (normalized === DEFAULT_PROFILE) throw new DefaultProfileProtectedError();

    const deleted = await this.repo.delete(normalized);
    if (!deleted) throw new ProfileNotFoundError(normalized);

    await this.audit.record({
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      action: 'profile.deleted',
      targetId: null,
      targetType: 'settings_profile',
      details: { gamme: normalized },
      ipAddress: ctx.ipAddress,
    });
    this.logger.log(`Profil ${normalized} supprimé par ${ctx.actorName}`);
  }

  /** Réinitialise un profil aux valeurs par défaut du schéma. */
  async reset(gamme: string, ctx: WriteContext): Promise<SettingsProfile> {
    const normalized = this.normalize(gamme);
    const profile = await this.save(normalized, { settings: defaultAnalysisSettings() }, ctx);

    await this.audit.record({
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      action: 'profile.reset',
      targetId: null,
      targetType: 'settings_profile',
      details: { gamme: normalized },
      ipAddress: ctx.ipAddress,
    });
    return profile;
  }

  // ── Export / import ───────────────────────────────────────────────────────

  /** Enveloppe d'export, autodescriptive et relisible sans contexte extérieur. */
  async export(gamme: string): Promise<ProfileExport> {
    const profile = await this.get(gamme);
    return {
      formatVersion: PROFILE_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      profile: profile.profile,
      label: profile.label,
      description: profile.description,
      sourceVersion: profile.version,
      settings: profile.settings,
    };
  }

  /**
   * Importe une enveloppe dans la gamme de DESTINATION passée en paramètre.
   *
   * La gamme du fichier est ignorée : importer un export `premium` sous `start`
   * est un cas légitime, et laisser le fichier choisir sa cible ouvrirait un
   * écrasement non voulu.
   */
  async import(
    gamme: string,
    payload: ProfileExport,
    expectedVersion: number | undefined,
    ctx: WriteContext,
  ): Promise<SettingsProfile> {
    const normalized = this.normalize(gamme);

    const profile = await this.save(
      normalized,
      {
        settings: payload.settings,
        label: payload.label,
        description: payload.description,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      },
      ctx,
    );

    await this.audit.record({
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      action: 'profile.imported',
      targetId: null,
      targetType: 'settings_profile',
      details: { gamme: normalized, sourceProfile: payload.profile },
      ipAddress: ctx.ipAddress,
    });
    return profile;
  }

  /** Crée le profil de repli s'il manque — appelé au démarrage. */
  async ensureDefaultProfile(): Promise<void> {
    if (!this.repo.available) return;

    const existing = await this.repo.currentVersion(DEFAULT_PROFILE);
    if (existing !== null) return;

    await this.repo.create(
      DEFAULT_PROFILE,
      'Profil par défaut',
      'Appliqué quand aucune gamme n’est détectée ou qu’aucun profil ne lui correspond',
      defaultAnalysisSettings(),
      'system',
    );
    this.logger.log('Profil « default » créé');
  }

  // ── Projection ────────────────────────────────────────────────────────────

  private defaultLabel(gamme: string): string {
    return gamme.charAt(0).toUpperCase() + gamme.slice(1);
  }

  private toMeta(row: ProfileMetaRow | ProfileRow): ProfileMeta {
    return {
      profile: row.gamme,
      label: row.label,
      description: row.description,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  private toProfile(row: ProfileRow): SettingsProfile {
    return { ...this.toMeta(row), settings: this.parseSettings(row) };
  }

  /**
   * Décode et valide la colonne JSON.
   *
   * Une ligne écrite par une version antérieure du schéma, ou modifiée à la
   * main en base, ne doit pas se propager telle quelle dans l'analyse : on
   * retombe sur les défauts et on trace, plutôt que de servir une forme
   * inattendue au moteur.
   */
  private parseSettings(row: ProfileRow): AnalysisSettings {
    const raw: unknown =
      typeof row.settings === 'string' ? this.safeJsonParse(row.settings) : row.settings;

    const result = AnalysisSettingsSchema.safeParse(raw);
    if (result.success) return result.data;

    this.logger.error(
      `Profil ${row.gamme} invalide en base (${result.error.issues.length} problème(s)) — ` +
        'repli sur les réglages par défaut',
    );
    return defaultAnalysisSettings();
  }

  private safeJsonParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
