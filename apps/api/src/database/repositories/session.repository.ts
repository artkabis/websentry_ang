import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

export interface SessionRow extends RowDataPacket {
  session_id: string;
  user_id: string;
  expires_at: string;
  revoked: number;
  token_version: number;
  rank: number;
  status: 'active' | 'suspended' | 'pending';
}

/**
 * Sessions de rafraîchissement.
 *
 * Le token BRUT n'est jamais stocké : seule son empreinte SHA-256 l'est. Une fuite
 * de la table ne permet donc pas de rejouer les sessions — l'attaquant possède le
 * condensé, pas le jeton attendu par le serveur.
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 32 octets d'entropie — jeton opaque, jamais dérivé d'une donnée utilisateur. */
  generateRawToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Crée une session et retourne le jeton brut (seule occasion où il existe). */
  async create(
    userId: string,
    expiryMs: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const rawToken = this.generateRawToken();
    await this.db.execute(
      `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        userId,
        this.hashToken(rawToken),
        new Date(Date.now() + expiryMs),
        ip,
        userAgent?.slice(0, 512) || null,
      ],
    );
    return rawToken;
  }

  /** Session jointe à son utilisateur — une seule requête pour tout valider. */
  findByRawToken(rawToken: string): Promise<SessionRow | null> {
    return this.db.queryOne<SessionRow>(
      `SELECT s.id AS session_id, s.user_id, s.expires_at, s.revoked,
              u.token_version, u.rank, u.status
         FROM user_sessions s
         INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1`,
      [this.hashToken(rawToken)],
    );
  }

  /**
   * Rotation : révoque la session présentée et en crée une nouvelle, de façon
   * ATOMIQUE. Un refresh token n'est ainsi utilisable qu'une fois — sa
   * réutilisation ultérieure tombe sur une ligne `revoked = 1`.
   */
  async rotate(
    oldSessionId: string,
    userId: string,
    expiryMs: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const newRawToken = this.generateRawToken();
    await this.db.transaction(async conn => {
      await conn.execute('UPDATE user_sessions SET revoked = 1 WHERE id = ?', [oldSessionId]);
      await conn.execute(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          userId,
          this.hashToken(newRawToken),
          new Date(Date.now() + expiryMs),
          ip,
          userAgent?.slice(0, 512) || null,
        ],
      );
    });
    return newRawToken;
  }

  /** Révoque toutes les sessions actives d'un utilisateur (déconnexion globale). */
  async revokeAllForUser(userId: string): Promise<number> {
    return this.db.execute(
      'UPDATE user_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0',
      [userId],
    );
  }

  /** Purge des sessions expirées (tâche de maintenance). */
  async deleteExpired(): Promise<number> {
    return this.db.execute('DELETE FROM user_sessions WHERE expires_at < NOW()');
  }
}
