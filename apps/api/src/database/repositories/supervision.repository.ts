import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

/**
 * Volumétrie de l'instance.
 *
 * Quatre comptages, et rien d'autre : la supervision dit ce que l'instance
 * PORTE, pas ce qu'elle contient. Une page qui listerait des domaines ou des
 * identifiants serait une page d'analyse, pas une page d'exploitation.
 *
 * Chaque compteur est BORNÉ dans le temps là où c'est possible : un
 * `COUNT(*)` sur toute la table des pages grossirait avec elle, et la
 * supervision deviendrait la requête la plus coûteuse de l'application.
 */
@Injectable()
export class SupervisionRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  private async compter(sql: string): Promise<number> {
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(sql);
    return ligne?.total ?? 0;
  }

  /** Pages analysées sur les dernières 24 heures. */
  scans24h(): Promise<number> {
    return this.compter(
      'SELECT COUNT(*) AS total FROM scan_pages WHERE analyzed_at >= NOW() - INTERVAL 1 DAY',
    );
  }

  scans7j(): Promise<number> {
    return this.compter(
      'SELECT COUNT(*) AS total FROM scan_pages WHERE analyzed_at >= NOW() - INTERVAL 7 DAY',
    );
  }

  comptesActifs(): Promise<number> {
    return this.compter("SELECT COUNT(*) AS total FROM users WHERE status = 'active'");
  }

  /** Retours qui attendent encore une décision. */
  retoursOuverts(): Promise<number> {
    return this.compter(
      "SELECT COUNT(*) AS total FROM feedback WHERE status IN ('nouveau', 'accepte', 'en_cours')",
    );
  }
}
