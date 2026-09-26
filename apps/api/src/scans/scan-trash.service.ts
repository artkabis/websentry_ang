import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type {
  TrashEntry,
  TrashExport,
  TrashListQuery,
  TrashListResponse,
  TrashRestoreResult,
} from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import {
  ScanTrashRepository,
  type Instantane,
  type TrashRow,
} from '../database/repositories/scan-trash.repository.js';
import { AuditService } from '../audit/audit.service.js';
import type { ScanActor } from './scans.service.js';
import { decoderLigne, encoderLigne, libelleCorbeille } from './scan-trash.util.js';

/** Ce qu'une suppression désigne, selon sa portée. */
export type CibleCorbeille =
  | { scope: 'session'; sessionId: string; siteId: string; domain: string; gamme: string | null }
  | { scope: 'site'; siteId: string; domain: string; gamme: string | null }
  | { scope: 'domain'; domain: string };

/**
 * Corbeille des scans — archivage avant suppression, restauration, export.
 *
 * L'archivage a lieu AVANT le `DELETE`, et c'est la seule ordonnance possible :
 * après la cascade, les lignes n'existent plus et il n'y a plus rien à
 * capturer. L'échec de l'archivage empêche donc la suppression — mieux vaut un
 * geste refusé qu'un effacement sans filet.
 */
@Injectable()
export class ScanTrashService {
  private readonly logger = new Logger(ScanTrashService.name);

  constructor(
    private readonly repo: ScanTrashRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  private assertAvailable(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException('Corbeille des scans indisponible');
    }
  }

  // ── Archivage ──────────────────────────────────────────────────────────────

  /**
   * Capture la cible dans la corbeille et rend l'identifiant de l'entrée.
   *
   * Rend `null` quand il n'y avait rien à archiver : supprimer un site déjà
   * vide ne doit pas remplir la corbeille d'entrées creuses que l'utilisateur
   * devrait ensuite trier.
   */
  async archiver(cible: CibleCorbeille, actor: ScanActor): Promise<string | null> {
    this.assertAvailable();

    const { siteIds, sessionIds, gamme } = await this.resoudre(cible);
    if (siteIds.length === 0 && sessionIds.length === 0) return null;

    const brut = await this.repo.capturer(siteIds, sessionIds);
    const instantane: Instantane = {
      sites: brut.sites.map(encoderLigne),
      sessions: brut.sessions.map(encoderLigne),
      pages: brut.pages.map(encoderLigne),
    };

    const json = JSON.stringify(instantane);
    const id = randomUUID();

    await this.repo.ajouter({
      id,
      scope: cible.scope,
      domain: cible.domain,
      gamme,
      label: libelleCorbeille(cible.scope, cible.domain, gamme),
      sessionCount: instantane.sessions.length,
      pageCount: instantane.pages.length,
      // `gzipSync` et non un flux : l'instantané est déjà entièrement en
      // mémoire, et un flux n'apporterait qu'un ordonnancement supplémentaire à
      // tenir juste au milieu d'une suppression.
      payloadGz: gzipSync(json),
      payloadBytes: Buffer.byteLength(json),
      deletedBy: actor.actorId,
      deletedByName: actor.actorName,
      purgeAfterDays: this.config.retention.trashRetentionDays,
    });

    return id;
  }

  /**
   * Archive un site désigné par son identité.
   *
   * L'appelant connaît le couple (domaine, gamme), pas l'identifiant technique :
   * le résoudre ici évite de faire circuler une lecture de plus dans le service
   * de l'historique.
   */
  async archiverSite(
    domain: string,
    gamme: string | null,
    actor: ScanActor,
  ): Promise<string | null> {
    const siteId = await this.repo.siteParIdentite(domain, gamme);
    // Rien à archiver : le site n'existe pas, et la suppression qui suit ne
    // touchera rien non plus.
    if (siteId === null) return null;
    return this.archiver({ scope: 'site', siteId, domain, gamme }, actor);
  }

  /** Ce que la portée désigne réellement, en identifiants. */
  private async resoudre(
    cible: CibleCorbeille,
  ): Promise<{ siteIds: string[]; sessionIds: string[]; gamme: string | null }> {
    if (cible.scope === 'session') {
      return { siteIds: [cible.siteId], sessionIds: [cible.sessionId], gamme: cible.gamme };
    }
    if (cible.scope === 'site') {
      return {
        siteIds: [cible.siteId],
        sessionIds: await this.repo.sessionsDesSites([cible.siteId]),
        gamme: cible.gamme,
      };
    }
    const siteIds = await this.repo.sitesDuDomaine(cible.domain);
    return {
      siteIds,
      sessionIds: await this.repo.sessionsDesSites(siteIds),
      // Un domaine n'a pas de gamme : plusieurs sites le partagent, chacun avec
      // la sienne. Forcer une valeur ici désignerait l'un d'eux au hasard.
      gamme: null,
    };
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  async lister(params: TrashListQuery): Promise<TrashListResponse> {
    this.assertAvailable();
    const offset = (params.page - 1) * params.limit;
    const total = await this.repo.compter(params);
    const rows = total === 0 ? [] : await this.repo.lister(params, params.limit, offset);
    return { items: rows.map(versEntree), total };
  }

  /** Instantané tel qu'il sera téléchargé — format versionné. */
  async exporter(id: string): Promise<TrashExport> {
    this.assertAvailable();
    const entree = await this.exigerEntree(id);
    const instantane = await this.lireInstantane(id);

    return {
      format: 1,
      scope: entree.scope,
      label: entree.label,
      deletedAt: entree.deleted_at,
      // Les lignes partent TELLES QUELLES, binaires encodés compris : un export
      // qu'on ne pourrait pas relire pour restaurer ailleurs serait un export
      // décoratif.
      sites: instantane.sites,
      sessions: instantane.sessions,
      pages: instantane.pages,
    };
  }

  // ── Restauration et purge ──────────────────────────────────────────────────

  async restaurer(id: string, actor: ScanActor): Promise<TrashRestoreResult> {
    this.assertAvailable();
    const entree = await this.exigerEntree(id);
    const instantane = await this.lireInstantane(id);

    const resultat = await this.repo.restaurer({
      sites: instantane.sites.map(decoderLigne),
      sessions: instantane.sessions.map(decoderLigne),
      pages: instantane.pages.map(decoderLigne),
    });

    // L'entrée disparaît de la corbeille : ce qui y reste est, par définition,
    // ce qui peut encore être restauré. Un état « restaurée » obligerait chaque
    // lecture à le filtrer, pour une information que le journal d'audit porte
    // déjà.
    await this.repo.supprimer(id);

    await this.audit.record({
      action: 'scans.trash_restore',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: { trashId: id, label: entree.label, scope: entree.scope, ...resultat },
    });

    if (resultat.skippedSessions > 0) {
      this.logger.warn(
        `Restauration ${entree.label} : ${resultat.skippedSessions} session(s) ignorée(s) — ` +
          'déjà présentes, probablement rescannées depuis la suppression',
      );
    }

    return resultat;
  }

  /** Efface une entrée sans la restaurer — le geste est définitif. */
  async purger(id: string, actor: ScanActor): Promise<void> {
    this.assertAvailable();
    const entree = await this.exigerEntree(id);
    await this.repo.supprimer(id);

    await this.audit.record({
      action: 'scans.trash_purge',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: {
        trashId: id,
        label: entree.label,
        scope: entree.scope,
        sessions: entree.session_count,
        pages: entree.page_count,
      },
    });
  }

  /** Passage de rétention — efface les entrées échues. Rend le nombre effacé. */
  async purgerEchues(): Promise<number> {
    if (!this.repo.available) return 0;
    const policy = this.config.retention;
    if (!policy.enabled) return 0;
    return this.repo.purger(policy.batchSize);
  }

  volumetrie(): Promise<{ entrees: number; octets: number; echues: number }> {
    return this.repo.volumetrie();
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private async exigerEntree(id: string): Promise<TrashRow> {
    const entree = await this.repo.trouver(id);
    if (!entree) throw new NotFoundException('Entrée de corbeille introuvable');
    return entree;
  }

  private async lireInstantane(id: string): Promise<Instantane> {
    const compresse = await this.repo.instantaneCompresse(id);
    if (!compresse) throw new NotFoundException('Entrée de corbeille introuvable');
    return JSON.parse(gunzipSync(compresse).toString('utf8')) as Instantane;
  }
}

function versEntree(row: TrashRow): TrashEntry {
  return {
    id: row.id,
    scope: row.scope,
    domain: row.domain,
    gamme: row.gamme,
    label: row.label,
    sessionCount: Number(row.session_count),
    pageCount: Number(row.page_count),
    payloadBytes: Number(row.payload_bytes),
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deletedByName: row.deleted_by_name,
    purgeAfter: row.purge_after,
  };
}
