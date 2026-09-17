import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

/** Ligne brute de `users` — usage INTERNE, jamais sérialisée vers un client. */
export interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  email: string | null;
  rank: number;
  status: 'active' | 'suspended' | 'pending';
  token_version: number;
  failed_logins: number;
  locked_until: string | null;
}

/**
 * Colonnes chargées lors d'une authentification.
 *
 * Liste explicite plutôt que `SELECT *` : une colonne ajoutée plus tard au schéma
 * (secret TOTP, jeton de récupération…) ne se retrouve pas automatiquement dans un
 * objet qui circule dans le code d'authentification.
 */
const AUTH_COLUMNS = `id, username, password_hash, display_name, email, rank, status,
                      token_version, failed_logins, locked_until`;

/**
 * Accès à la table `users`.
 *
 * Chaque requête est paramétrée (`?`) — aucune valeur d'entrée n'est interpolée
 * dans le texte SQL.
 */
@Injectable()
export class UserRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /** Recherche par nom d'utilisateur (normalisé en minuscules par l'appelant). */
  findByUsername(username: string): Promise<UserRow | null> {
    return this.db.queryOne<UserRow>(
      `SELECT ${AUTH_COLUMNS} FROM users WHERE username = ? LIMIT 1`,
      [username],
    );
  }

  findById(id: string): Promise<UserRow | null> {
    return this.db.queryOne<UserRow>(`SELECT ${AUTH_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [
      id,
    ]);
  }

  /** Enregistre un échec de connexion et pose éventuellement un verrou temporaire. */
  async recordFailedLogin(
    userId: string,
    failedLogins: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.db.execute(
      'UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = NOW() WHERE id = ?',
      [failedLogins, lockedUntil, userId],
    );
  }

  /** Remet le compteur d'échecs à zéro après une connexion réussie. */
  async resetFailedLogins(userId: string): Promise<void> {
    await this.db.execute('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [
      userId,
    ]);
  }

  /**
   * Incrémente `token_version` — révocation immédiate de TOUS les access tokens
   * du compte, y compris ceux encore dans leur fenêtre de validité.
   */
  async bumpTokenVersion(userId: string): Promise<void> {
    await this.db.execute(
      'UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = ?',
      [userId],
    );
  }
}
