import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

export interface PermissionRow extends RowDataPacket {
  permission: string;
  gammes: string[] | null;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
}

/**
 * Permissions fines par utilisateur.
 *
 * Un grant temporaire expiré est INACTIF, jamais supprimé : la clause
 * `expires_at IS NULL OR expires_at > NOW()` est appliquée systématiquement,
 * côté SQL, pour qu'aucun chemin d'appel ne puisse l'oublier.
 */
const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > NOW())';

@Injectable()
export class PermissionRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Toutes les permissions actives d'un utilisateur. */
  findAllForUser(userId: string): Promise<PermissionRow[]> {
    return this.db.query<PermissionRow>(
      `SELECT permission, gammes, granted_by, granted_at, expires_at
         FROM user_permissions
        WHERE user_id = ? AND ${NOT_EXPIRED}`,
      [userId],
    );
  }

  /** Une permission précise, ou `null` si absente / expirée. */
  findOne(userId: string, code: string): Promise<PermissionRow | null> {
    return this.db.queryOne<PermissionRow>(
      `SELECT permission, gammes, granted_by, granted_at, expires_at
         FROM user_permissions
        WHERE user_id = ? AND permission = ? AND ${NOT_EXPIRED}
        LIMIT 1`,
      [userId, code],
    );
  }
}
