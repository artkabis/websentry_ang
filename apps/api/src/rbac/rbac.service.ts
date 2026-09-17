import { Injectable } from '@nestjs/common';
import {
  RANKS,
  defaultPermissionsForRank,
  rankHasPermission,
  type GrantedPermission,
} from '@websentry/shared';
import { PermissionRepository } from '../database/repositories/permission.repository.js';

/**
 * Résolution des autorisations.
 *
 * Deux moteurs coexistent, comme en v1 :
 *   • le RANG, qui porte les défauts et les seuils de route ;
 *   • les PERMISSIONS FINES en base, qui délèguent un accès précis (éventuellement
 *     temporaire, éventuellement restreint à certaines gammes) à un rang inférieur.
 *
 * Le super_admin (rang 100) court-circuite les deux : aucune requête en base, scope
 * toujours ouvert. C'est voulu — le compte de dernier recours ne doit pas pouvoir
 * être enfermé dehors par une base en panne.
 */
@Injectable()
export class RbacService {
  constructor(private readonly permissions: PermissionRepository) {}

  /** Défauts du rang — utilisés quand la base de permissions n'est pas consultable. */
  defaultsForRank(rank: number): readonly string[] {
    return defaultPermissionsForRank(rank);
  }

  rankGrants(rank: number, code: string): boolean {
    return rankHasPermission(rank, code);
  }

  isSuperAdmin(rank: number): boolean {
    return rank >= RANKS.SUPER_ADMIN;
  }

  isAdmin(rank: number): boolean {
    return rank >= RANKS.ADMIN;
  }

  /**
   * Résout une permission pour un utilisateur.
   *
   * @returns le scope de gammes (`null` = toutes) si accordée, `null` si refusée.
   */
  async resolve(
    userId: string,
    rank: number,
    code: string,
  ): Promise<{ gammes: string[] | null } | null> {
    if (this.isSuperAdmin(rank)) return { gammes: null };

    const row = await this.permissions.findOne(userId, code);
    if (row) return { gammes: this.normalizeGammes(row.gammes) };

    // Repli sur les défauts du rang : un admin garde ses accès même sans ligne
    // explicite en base (parité v1 `requireAdminOrPermission`).
    if (this.rankGrants(rank, code)) return { gammes: null };

    return null;
  }

  /** Permissions actives d'un utilisateur, prêtes à être renvoyées au front. */
  async listForUser(userId: string): Promise<GrantedPermission[]> {
    const rows = await this.permissions.findAllForUser(userId);
    return rows.map(r => ({
      permission: r.permission,
      gammes: this.normalizeGammes(r.gammes),
    }));
  }

  /**
   * Vérifie qu'une gamme demandée entre dans le scope accordé.
   * `null`/absent = aucune restriction.
   */
  gammeInScope(gammes: string[] | null, gamme: string | null | undefined): boolean {
    if (!gamme) return true;
    if (!gammes) return true;
    const normalized = gamme.toLowerCase();
    return gammes.some(g => g.toLowerCase() === normalized);
  }

  /**
   * La colonne `gammes` est un JSON MariaDB : le driver peut rendre un tableau
   * déjà décodé, une chaîne JSON, ou NULL. On normalise ici une fois pour toutes
   * plutôt que dans chaque appelant.
   */
  private normalizeGammes(raw: unknown): string[] | null {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
