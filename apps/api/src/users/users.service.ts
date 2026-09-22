import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  RANKS,
  defaultPermissionsForRank,
  rankToRole,
  type CreateUserInput,
  type GrantPermissionInput,
  type UpdateUserInput,
  type UserListQuery,
  type UserListResponse,
  type UserPermission,
  type UserSummary,
} from '@websentry/shared';
import { AuditService } from '../audit/audit.service.js';
import { SessionRepository } from '../database/repositories/session.repository.js';
import {
  UserAdminRepository,
  type AdminUserRow,
} from '../database/repositories/user-admin.repository.js';
import { UserRepository } from '../database/repositories/user.repository.js';
import { PasswordService } from '../security/password.service.js';

/** Qui agit — pour les garde-fous de rang et pour la trace d'audit. */
export interface Actor {
  id: string;
  username: string;
  rank: number;
  ipAddress: string | null;
}

/**
 * Gestion des comptes.
 *
 * Quatre garde-fous portent ce module, et ils comptent plus que le CRUD :
 *
 *  1. **On n'accorde jamais au-dessus de son propre rang.** Sans cette règle,
 *     un administrateur se fabrique un super_admin et devient super_admin.
 *  2. **On ne se modifie pas soi-même.** Ni rang, ni statut : c'est ainsi qu'on
 *     s'enferme dehors, ou qu'on s'élève en deux temps.
 *  3. **Le dernier administrateur actif ne se retire pas.** Supprimer,
 *     suspendre ou rétrograder le dernier compte capable d'administrer laisse
 *     une instance que plus personne ne peut reprendre en main.
 *  4. **Toute écriture révoque.** Changer un rang, un statut ou un mot de passe
 *     incrémente `token_version` : les jetons déjà émis cessent de valoir, sans
 *     attendre leur expiration.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly admin: UserAdminRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /**
   * L'administration suppose la base où vivent les comptes.
   *
   * Le mode « sans base » porte deux comptes de développement dans un fichier ;
   * les administrer par l'API donnerait une seconde façon de les écrire, et un
   * écran qui marcherait à moitié. On refuse clairement plutôt qu'à moitié.
   */
  private requireDatabase(): void {
    if (!this.admin.available) {
      throw new ServiceUnavailableException(
        'La gestion des comptes exige une base de données (DB_ENABLED=false).',
      );
    }
  }

  async list(query: UserListQuery): Promise<UserListResponse> {
    this.requireDatabase();
    const filtres = { search: query.search, rank: query.rank, status: query.status };

    const [lignes, total] = await Promise.all([
      this.admin.list(filtres, query.limit, query.offset),
      this.admin.count(filtres),
    ]);

    return { users: lignes.map(versResume), total };
  }

  async get(id: string): Promise<UserSummary> {
    this.requireDatabase();
    return versResume(await this.requireUser(id));
  }

  async create(entree: CreateUserInput, acteur: Actor): Promise<UserSummary> {
    this.requireDatabase();
    this.refuseRangSuperieur(entree.rank, acteur);

    if (await this.users.findByUsername(entree.username)) {
      throw new ConflictException('Cet identifiant est déjà pris.');
    }

    const id = randomUUID();
    await this.admin.create({
      id,
      username: entree.username,
      passwordHash: await this.passwords.hash(entree.password),
      rank: entree.rank,
      displayName: entree.displayName ?? null,
      email: entree.email ?? null,
      createdBy: acteur.id,
    });

    await this.trace(acteur, 'user.create', id, { username: entree.username, rank: entree.rank });
    return versResume(await this.requireUser(id));
  }

  async update(id: string, entree: UpdateUserInput, acteur: Actor): Promise<UserSummary> {
    this.requireDatabase();
    const cible = await this.requireUser(id);

    if (id === acteur.id && (entree.rank !== undefined || entree.status !== undefined)) {
      throw new ForbiddenException(
        'Vous ne pouvez pas changer votre propre rang ni votre propre statut.',
      );
    }
    // On ne touche pas à plus haut que soi — sans quoi un administrateur
    // suspendrait un super_admin, puis prendrait sa place.
    this.refuseRangSuperieur(cible.rank, acteur);
    if (entree.rank !== undefined) this.refuseRangSuperieur(entree.rank, acteur);

    const perdAdministration =
      (entree.rank !== undefined && entree.rank < RANKS.ADMIN) ||
      (entree.status !== undefined && entree.status !== 'active');
    if (perdAdministration) await this.refuseDernierAdministrateur(cible);

    await this.admin.update(id, {
      rank: entree.rank,
      status: entree.status,
      display_name: entree.displayName,
      email: entree.email,
    });

    // Un rang ou un statut modifié doit valoir TOUT DE SUITE : sans révocation,
    // un compte suspendu garde son accès jusqu'à l'expiration de son jeton.
    if (entree.rank !== undefined || entree.status !== undefined) {
      await this.users.bumpTokenVersion(id);
    }
    if (entree.status !== undefined && entree.status !== 'active') {
      await this.sessions.revokeAllForUser(id);
    }

    await this.trace(acteur, 'user.update', id, { ...entree });
    return versResume(await this.requireUser(id));
  }

  async resetPassword(id: string, motDePasse: string, acteur: Actor): Promise<void> {
    this.requireDatabase();
    const cible = await this.requireUser(id);
    this.refuseRangSuperieur(cible.rank, acteur);

    await this.admin.updatePassword(id, await this.passwords.hash(motDePasse));
    // Le mot de passe change : les sessions ouvertes avec l'ancien tombent.
    await this.sessions.revokeAllForUser(id);

    // Le mot de passe n'apparaît NULLE PART dans la trace — ni en clair, ni
    // haché : un journal se lit plus facilement qu'une table de comptes.
    await this.trace(acteur, 'user.password_reset', id, { username: cible.username });
  }

  async remove(id: string, acteur: Actor): Promise<void> {
    this.requireDatabase();
    const cible = await this.requireUser(id);

    if (id === acteur.id) {
      throw new ForbiddenException('Vous ne pouvez pas supprimer votre propre compte.');
    }
    this.refuseRangSuperieur(cible.rank, acteur);
    await this.refuseDernierAdministrateur(cible);

    await this.sessions.revokeAllForUser(id);
    await this.admin.delete(id);
    await this.trace(acteur, 'user.delete', id, { username: cible.username, rank: cible.rank });
  }

  async listPermissions(id: string): Promise<UserPermission[]> {
    this.requireDatabase();
    await this.requireUser(id);

    return (await this.admin.list_permissions(id)).map(ligne => ({
      permission: String(ligne['permission']),
      gammes: lireGammes(ligne['gammes']),
      grantedBy: ligne['granted_by'] === null ? null : String(ligne['granted_by']),
      grantedAt: new Date(String(ligne['granted_at'])).toISOString(),
      expiresAt:
        ligne['expires_at'] === null ? null : new Date(String(ligne['expires_at'])).toISOString(),
    }));
  }

  async grantPermission(id: string, octroi: GrantPermissionInput, acteur: Actor): Promise<void> {
    this.requireDatabase();
    const cible = await this.requireUser(id);
    this.refuseRangSuperieur(cible.rank, acteur);

    // Déléguer ce qu'on n'a pas soi-même reviendrait à contourner son propre
    // rang par personne interposée.
    if (!this.acteurDetient(acteur, octroi.permission)) {
      throw new ForbiddenException(
        'Vous ne pouvez déléguer qu’une permission que vous détenez vous-même.',
      );
    }

    await this.admin.grantPermission({
      userId: id,
      permission: octroi.permission,
      gammes: octroi.gammes,
      grantedBy: acteur.id,
      expiresAt: octroi.expiresAt ? new Date(octroi.expiresAt) : null,
    });
    await this.users.bumpTokenVersion(id);
    await this.trace(acteur, 'user.permission_grant', id, { ...octroi });
  }

  async revokePermission(id: string, permission: string, acteur: Actor): Promise<void> {
    this.requireDatabase();
    const cible = await this.requireUser(id);
    this.refuseRangSuperieur(cible.rank, acteur);

    const supprimees = await this.admin.revokePermission(id, permission);
    if (supprimees === 0) throw new NotFoundException('Cette permission n’était pas accordée.');

    await this.users.bumpTokenVersion(id);
    await this.trace(acteur, 'user.permission_revoke', id, { permission });
  }

  // ── Garde-fous ────────────────────────────────────────────────────────────

  private async requireUser(id: string): Promise<AdminUserRow> {
    const compte = await this.admin.findById(id);
    if (!compte) throw new NotFoundException('Compte introuvable.');
    return compte;
  }

  /** Nul n'agit sur un rang supérieur ou égal au sien — sauf le super_admin. */
  private refuseRangSuperieur(rangVise: number, acteur: Actor): void {
    if (acteur.rank >= RANKS.SUPER_ADMIN) return;
    if (rangVise >= acteur.rank) {
      throw new ForbiddenException(
        'Vous ne pouvez pas agir sur un compte de rang supérieur ou égal au vôtre.',
      );
    }
  }

  /**
   * Refuse de retirer le DERNIER compte capable d'administrer.
   *
   * Une instance sans administrateur actif ne se reprend pas en main depuis
   * l'interface : il faudrait rouvrir la base à la main.
   */
  private async refuseDernierAdministrateur(cible: AdminUserRow): Promise<void> {
    if (cible.rank < RANKS.ADMIN || cible.status !== 'active') return;

    const actifs = await this.admin.countActiveAtLeastRank(RANKS.ADMIN);
    if (actifs <= 1) {
      throw new BadRequestException(
        'C’est le dernier compte d’administration actif — l’instance deviendrait ingérable.',
      );
    }
  }

  /** Le super_admin détient tout ; les autres, ce que leur rang accorde. */
  private acteurDetient(acteur: Actor, permission: string): boolean {
    if (acteur.rank >= RANKS.SUPER_ADMIN) return true;
    return (defaultPermissionsForRank(acteur.rank) as readonly string[]).includes(permission);
  }

  private trace(
    acteur: Actor,
    action: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorId: acteur.id,
      actorName: acteur.username,
      action,
      targetId,
      targetType: 'user',
      details,
      ipAddress: acteur.ipAddress,
    });
  }
}

/** Ligne de base → forme exposée. L'empreinte n'y entre jamais. */
function versResume(ligne: AdminUserRow): UserSummary {
  return {
    id: ligne.id,
    username: ligne.username,
    displayName: ligne.display_name,
    email: ligne.email,
    rank: ligne.rank,
    role: rankToRole(ligne.rank),
    status: ligne.status,
    lockedUntil: ligne.locked_until ? new Date(ligne.locked_until).toISOString() : null,
    totalScansLaunched: ligne.total_scans_launched,
    createdAt: new Date(ligne.created_at).toISOString(),
    updatedAt: new Date(ligne.updated_at).toISOString(),
  };
}

/**
 * `gammes` est une colonne JSON : selon le pilote, un tableau déjà décodé ou
 * son texte. `null` signifie « toutes les gammes », et c'est aussi ce que rend
 * une colonne illisible — la portée la plus large est ici la plus SÛRE à
 * afficher, puisque c'est la garde RBAC, et non cet écran, qui tranche l'accès.
 */
function lireGammes(valeur: unknown): string[] | null {
  let lu = valeur;
  if (typeof lu === 'string') {
    try {
      lu = JSON.parse(lu);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(lu)) return null;

  // Une gamme n'est jamais qu'une chaîne : un élément d'un autre type signale
  // une colonne corrompue, et le convertir en texte masquerait le problème.
  return lu.filter((gamme): gamme is string => typeof gamme === 'string');
}
