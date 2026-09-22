import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService, type SqlParam } from '../database.service.js';

/**
 * Administration des comptes.
 *
 * SÉPARÉ du dépôt d'authentification, et volontairement : celui-ci a une
 * implémentation « sans base » pour le développement, qui n'aurait aucun sens
 * ici — gérer des comptes suppose la base où ils vivent. Les mélanger
 * obligerait à doubler chaque requête d'administration dans un magasin de
 * fichier que personne n'administre.
 *
 * Chaque requête est paramétrée : aucune valeur d'entrée n'est interpolée.
 */

export interface AdminUserRow extends RowDataPacket {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  rank: number;
  status: 'active' | 'suspended' | 'pending';
  locked_until: string | null;
  total_scans_launched: number;
  created_at: string;
  updated_at: string;
}

/** Colonnes exposables — l'empreinte et les compteurs d'échec n'en sont pas. */
const ADMIN_COLUMNS = `id, username, display_name, email, rank, status, locked_until,
                       total_scans_launched, created_at, updated_at`;

export interface UserFilters {
  search?: string;
  rank?: number;
  status?: string;
}

@Injectable()
export class UserAdminRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /**
   * Construit le filtre commun à la liste et au comptage.
   *
   * Une seule fabrique pour les deux : deux constructions séparées finiraient
   * par diverger, et le total annoncé ne correspondrait plus aux lignes
   * affichées.
   */
  private static filtre(filters: UserFilters): { where: string; params: SqlParam[] } {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    if (filters.search) {
      clauses.push('(username LIKE ? OR display_name LIKE ? OR email LIKE ?)');
      // Les jokers sont posés ICI, sur une valeur paramétrée : les
      // concaténer dans le texte SQL rouvrirait l'injection que `?` ferme.
      const motif = `%${filters.search}%`;
      params.push(motif, motif, motif);
    }
    if (filters.rank !== undefined) {
      clauses.push('rank = ?');
      params.push(filters.rank);
    }
    if (filters.status !== undefined) {
      clauses.push('status = ?');
      params.push(filters.status);
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  list(filters: UserFilters, limit: number, offset: number): Promise<AdminUserRow[]> {
    const { where, params } = UserAdminRepository.filtre(filters);
    return this.db.query<AdminUserRow>(
      `SELECT ${ADMIN_COLUMNS} FROM users ${where} ORDER BY rank DESC, username ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async count(filters: UserFilters): Promise<number> {
    const { where, params } = UserAdminRepository.filtre(filters);
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM users ${where}`,
      params,
    );
    return ligne?.total ?? 0;
  }

  findById(id: string): Promise<AdminUserRow | null> {
    return this.db.queryOne<AdminUserRow>(`SELECT ${ADMIN_COLUMNS} FROM users WHERE id = ?`, [id]);
  }

  /** Combien de comptes ACTIFS portent au moins ce rang — garde-fou anti-verrouillage. */
  async countActiveAtLeastRank(rank: number): Promise<number> {
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      "SELECT COUNT(*) AS total FROM users WHERE rank >= ? AND status = 'active'",
      [rank],
    );
    return ligne?.total ?? 0;
  }

  async create(compte: {
    id: string;
    username: string;
    passwordHash: string;
    rank: number;
    displayName: string | null;
    email: string | null;
    createdBy: string | null;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO users (id, username, password_hash, rank, display_name, email, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        compte.id,
        compte.username,
        compte.passwordHash,
        compte.rank,
        compte.displayName,
        compte.email,
        compte.createdBy,
      ],
    );
  }

  /**
   * Applique les champs fournis, et eux seuls.
   *
   * Une mise à jour qui réécrirait les champs absents avec `null` effacerait un
   * courriel parce qu'on a changé un rang.
   */
  async update(
    id: string,
    champs: Partial<{
      rank: number;
      status: string;
      display_name: string | null;
      email: string | null;
    }>,
  ): Promise<number> {
    const entrees: [string, SqlParam][] = [];
    for (const [colonne, valeur] of Object.entries(champs)) {
      if (valeur !== undefined) entrees.push([colonne, valeur]);
    }
    if (entrees.length === 0) return 0;

    // Les noms de colonnes viennent d'un objet TYPÉ, jamais de l'entrée
    // utilisateur : seules les valeurs passent par `?`, et c'est suffisant
    // parce qu'aucune clé n'est choisie par l'appelant HTTP.
    return this.db.execute(
      `UPDATE users SET ${entrees.map(([colonne]) => `${colonne} = ?`).join(', ')},
                        updated_at = NOW()
        WHERE id = ?`,
      [...entrees.map(([, valeur]) => valeur), id],
    );
  }

  async updatePassword(id: string, passwordHash: string): Promise<number> {
    return this.db.execute(
      `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL,
                        token_version = token_version + 1, updated_at = NOW()
        WHERE id = ?`,
      [passwordHash, id],
    );
  }

  async delete(id: string): Promise<number> {
    // Les sessions et les permissions partent en cascade (clés étrangères).
    return this.db.execute('DELETE FROM users WHERE id = ?', [id]);
  }

  /** Permissions fines d'un compte, expirées comprises — l'écran doit les montrer. */
  list_permissions(userId: string): Promise<RowDataPacket[]> {
    return this.db.query<RowDataPacket>(
      `SELECT permission, gammes, granted_by, granted_at, expires_at
         FROM user_permissions WHERE user_id = ? ORDER BY permission`,
      [userId],
    );
  }

  async grantPermission(octroi: {
    userId: string;
    permission: string;
    gammes: string[] | null;
    grantedBy: string;
    expiresAt: Date | null;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO user_permissions (user_id, permission, gammes, granted_by, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE gammes = VALUES(gammes), granted_by = VALUES(granted_by),
                               granted_at = NOW(), expires_at = VALUES(expires_at)`,
      [
        octroi.userId,
        octroi.permission,
        octroi.gammes ? JSON.stringify(octroi.gammes) : null,
        octroi.grantedBy,
        octroi.expiresAt,
      ],
    );
  }

  async revokePermission(userId: string, permission: string): Promise<number> {
    return this.db.execute('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?', [
      userId,
      permission,
    ]);
  }
}
