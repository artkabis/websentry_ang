import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService, type SqlParam } from '../database.service.js';
import { placeholders } from './scan.repository.js';

export interface CompressibleRow extends RowDataPacket {
  id: string;
  report: string;
}

export interface PendingCountRow extends RowDataPacket {
  compressible: number;
  purgeable: number;
}

/**
 * Rétention des rapports — les requêtes du travail de fond.
 *
 * Séparées du reste de l'historique parce que leur contrainte est différente :
 * ces requêtes touchent potentiellement des millions de lignes, hors de toute
 * requête HTTP. Elles travaillent donc par LOTS BORNÉS, et rendent la main en
 * disant ce qu'il reste à faire.
 */
@Injectable()
export class ScanRetentionRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /** Rapports en clair plus vieux que `days`, candidats à la compression. */
  findCompressible(days: number, limit: number): Promise<CompressibleRow[]> {
    return this.db.query<CompressibleRow>(
      `SELECT id, report
         FROM scan_pages
        WHERE analyzed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
          AND is_compressed = 0
          AND report IS NOT NULL
        ORDER BY analyzed_at ASC
        LIMIT ?`,
      [days, limit],
    );
  }

  /**
   * Remplace les rapports en clair par leur version compressée.
   *
   * Un seul `UPDATE ... CASE` par lot plutôt qu'une requête par ligne : sur un
   * lot de 200, la différence entre un aller-retour et deux cents décide si le
   * travail de fond tient dans sa fenêtre ou déborde sur les requêtes servies.
   */
  compress(updates: ReadonlyArray<{ id: string; gz: Buffer }>): Promise<number> {
    if (updates.length === 0) return Promise.resolve(0);

    const cases = updates.map(() => 'WHEN id = ? THEN ?').join(' ');
    const values: SqlParam[] = [];
    for (const update of updates) values.push(update.id, update.gz);
    for (const update of updates) values.push(update.id);

    return this.db.execute(
      `UPDATE scan_pages
          SET report_gz = CASE ${cases} END,
              report = NULL,
              is_compressed = 1
        WHERE id IN (${placeholders(updates.length)})`,
      values,
    );
  }

  /**
   * Purge les rapports plus vieux que `days`, par lot borné.
   *
   * `report_purged_at` est DATÉ ici — c'est ce qui permettra de répondre « ce
   * rapport a été purgé le … » au lieu d'un 404 laissant croire à une erreur.
   * La v1 se contentait de vider les colonnes, rendant la ligne indiscernable
   * d'une page qui n'a jamais eu de rapport.
   *
   * Le `LIMIT` n'est pas une précaution de style : sans lui, un premier passage
   * sur une base de production verrouillerait des millions de lignes dans une
   * seule instruction, pendant que l'application attend.
   */
  purge(days: number, limit: number): Promise<number> {
    return this.db.execute(
      `UPDATE scan_pages
          SET report = NULL,
              report_gz = NULL,
              is_compressed = 0,
              report_purged_at = UTC_TIMESTAMP()
        WHERE analyzed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
          AND (report IS NOT NULL OR report_gz IS NOT NULL)
        ORDER BY analyzed_at ASC
        LIMIT ?`,
      [days, limit],
    );
  }

  /**
   * Ce qu'il reste à traiter après un passage.
   *
   * Sans ce décompte, un travail de fond borné à N lignes par jour ne peut pas
   * savoir qu'il prend du retard : la v1 s'arrêtait à 500 lignes sans jamais
   * signaler que la file grandissait plus vite qu'elle ne se vidait.
   */
  async countPending(compressAfterDays: number, purgeAfterDays: number): Promise<PendingCountRow> {
    const row = await this.db.queryOne<PendingCountRow>(
      `SELECT
         SUM(analyzed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
             AND is_compressed = 0 AND report IS NOT NULL)          AS compressible,
         SUM(analyzed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
             AND (report IS NOT NULL OR report_gz IS NOT NULL))     AS purgeable
       FROM scan_pages`,
      [compressAfterDays, purgeAfterDays],
    );
    return {
      compressible: Number(row?.compressible ?? 0),
      purgeable: Number(row?.purgeable ?? 0),
    } as PendingCountRow;
  }
}
