import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

export interface AuditEntry {
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetId?: string | null;
  targetType?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export interface AuditRow extends RowDataPacket {
  id: number;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_id: string | null;
  target_type: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

/**
 * Journal d'audit — APPEND-ONLY.
 *
 * Ce repository n'expose délibérément QUE `append` et `list` : aucune méthode
 * d'UPDATE ni de DELETE n'existe, donc aucun code applicatif ne peut réécrire
 * l'historique, même par erreur. La contrainte est structurelle, pas conventionnelle.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  async append(entry: AuditEntry): Promise<void> {
    await this.db.execute(
      `INSERT INTO audit_log (actor_id, actor_name, action, target_id, target_type, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorId,
        entry.actorName,
        entry.action,
        entry.targetId ?? null,
        entry.targetType ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ipAddress ?? null,
      ],
    );
  }

  /** Lecture paginée, la plus récente d'abord. Bornes appliquées par l'appelant. */
  list(limit: number, offset: number): Promise<AuditRow[]> {
    return this.db.query<AuditRow>(
      `SELECT id, actor_id, actor_name, action, target_id, target_type, details, ip_address, created_at
         FROM audit_log
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
  }
}
