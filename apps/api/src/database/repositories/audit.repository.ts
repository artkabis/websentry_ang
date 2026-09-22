import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService, type SqlParam } from '../database.service.js';

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

/** Colonnes lues — liste explicite, jamais `SELECT *`. */
const COLONNES = `id, actor_id, actor_name, action, target_id, target_type,
                  details, ip_address, created_at`;

export interface AuditFilters {
  actor?: string;
  action?: string;
  targetId?: string;
  from?: string;
  to?: string;
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
  list(limit: number, offset: number, filtres: AuditFilters = {}): Promise<AuditRow[]> {
    const { where, params } = AuditRepository.filtre(filtres);
    return this.db.query<AuditRow>(
      `SELECT ${COLONNES} FROM audit_log ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  /** Total AVANT pagination — même filtre que `list`, par construction. */
  async count(filtres: AuditFilters = {}): Promise<number> {
    const { where, params } = AuditRepository.filtre(filtres);
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM audit_log ${where}`,
      params,
    );
    return ligne?.total ?? 0;
  }

  /**
   * Filtre commun à la lecture et au comptage.
   *
   * Une seule fabrique pour les deux : deux constructions séparées finiraient
   * par diverger, et le total annoncé ne correspondrait plus aux lignes lues.
   */
  private static filtre(filtres: AuditFilters): { where: string; params: SqlParam[] } {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    if (filtres.actor) {
      clauses.push('(actor_name LIKE ? OR actor_id = ?)');
      // Le joker est posé sur une valeur PARAMÉTRÉE : le concaténer dans le
      // texte SQL rouvrirait l'injection que le « ? » ferme.
      params.push(`%${filtres.actor}%`, filtres.actor);
    }
    if (filtres.action) {
      // Préfixe : « user. » ramène toute la famille des actions sur les comptes.
      clauses.push('action LIKE ?');
      params.push(`${filtres.action}%`);
    }
    if (filtres.targetId) {
      clauses.push('target_id = ?');
      params.push(filtres.targetId);
    }
    if (filtres.from) {
      clauses.push('created_at >= ?');
      params.push(`${filtres.from} 00:00:00`);
    }
    if (filtres.to) {
      // Borne INCLUSIVE : « jusqu'au 31 » doit contenir le 31 tout entier, et
      // non s'arrêter à son premier instant.
      clauses.push('created_at <= ?');
      params.push(`${filtres.to} 23:59:59`);
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
}
