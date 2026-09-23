import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

/**
 * Analytics d'usage — lectures agrégées, et l'anonymisation.
 *
 * Ce dépôt ne SÉLECTIONNE jamais un identifiant ni un nom : il compte des
 * comptes distincts. C'est vérifiable ligne à ligne dans le SQL ci-dessous, et
 * c'est le seul endroit où la garantie peut être posée — une fois la donnée
 * remontée, la retirer relèverait de la discipline.
 *
 * L'anonymisation vit ici et NON dans `AuditRepository`, qui n'expose
 * délibérément ni UPDATE ni DELETE. La distinction est nette : le journal
 * d'audit reste inréécrivable sur ce qui s'est PASSÉ ; ce dépôt retire QUI,
 * passé le délai de conservation, ce que la réglementation impose. Aucune
 * route HTTP ne l'atteint — seul le travail de fond l'appelle.
 */

export interface CompteurRow extends RowDataPacket {
  comptes: number;
  actions: number;
}

export interface JourRow extends RowDataPacket {
  jour: string;
  total: number;
}

export interface GammeRow extends RowDataPacket {
  gamme: string | null;
  analyses: number;
  score_moyen: number | null;
}

@Injectable()
export class UsageRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /**
   * Comptes distincts et actions, pour un ensemble d'actions du journal.
   *
   * `COUNT(DISTINCT actor_id)` et non `COUNT(*)` : le tunnel parle de
   * personnes qui atteignent une étape, pas d'événements. Une seule personne
   * qui se connecte quarante fois ne fait pas quarante comptes.
   */
  async compteurAudit(actions: readonly string[], depuis: string): Promise<CompteurRow | null> {
    if (actions.length === 0) return null;
    const trous = actions.map(() => '?').join(', ');
    return this.db.queryOne<CompteurRow>(
      `SELECT COUNT(DISTINCT actor_id) AS comptes, COUNT(*) AS actions
         FROM audit_log
        WHERE action IN (${trous}) AND created_at >= ? AND actor_id IS NOT NULL`,
      [...actions, depuis],
    );
  }

  /** Comptes distincts ayant fait QUOI QUE CE SOIT sur la période. */
  async comptesActifs(depuis: string): Promise<number> {
    const ligne = await this.db.queryOne<RowDataPacket & { comptes: number }>(
      `SELECT COUNT(DISTINCT actor_id) AS comptes
         FROM audit_log
        WHERE created_at >= ? AND actor_id IS NOT NULL`,
      [depuis],
    );
    return Number(ligne?.comptes ?? 0);
  }

  /**
   * Comptes distincts et analyses lancées.
   *
   * L'historique des scans porte `launched_by`, un NOM au moment du scan et
   * non une clé : c'est ce que la table a, et le compter en distinct suffit.
   */
  async compteurAnalyses(depuis: string): Promise<CompteurRow | null> {
    return this.db.queryOne<CompteurRow>(
      `SELECT COUNT(DISTINCT launched_by) AS comptes, COUNT(*) AS actions
         FROM scan_sessions
        WHERE analyzed_at >= ? AND launched_by IS NOT NULL`,
      [depuis],
    );
  }

  /** Connexions par jour — une ligne par jour NON VIDE. */
  connexionsParJour(depuis: string): Promise<JourRow[]> {
    return this.db.query<JourRow>(
      `SELECT DATE(created_at) AS jour, COUNT(*) AS total
         FROM audit_log
        WHERE action = 'auth.login' AND created_at >= ?
        GROUP BY DATE(created_at)
        ORDER BY jour ASC`,
      [depuis],
    );
  }

  /** Analyses par jour — même forme, autre source. */
  analysesParJour(depuis: string): Promise<JourRow[]> {
    return this.db.query<JourRow>(
      `SELECT DATE(analyzed_at) AS jour, COUNT(*) AS total
         FROM scan_sessions
        WHERE analyzed_at >= ?
        GROUP BY DATE(analyzed_at)
        ORDER BY jour ASC`,
      [depuis],
    );
  }

  /**
   * Répartition par gamme.
   *
   * La moyenne est pondérée par le NOMBRE DE PAGES : une session d'une page à
   * 100 et une de cent pages à 50 ne pèsent pas pareil, et une moyenne de
   * moyennes dirait 75 là où le site vaut 50,5.
   */
  gammes(depuis: string, limite = 20): Promise<GammeRow[]> {
    return this.db.query<GammeRow>(
      `SELECT gamme,
              COUNT(*) AS analyses,
              CASE WHEN SUM(CASE WHEN avg_score IS NULL THEN 0 ELSE page_count END) = 0
                   THEN NULL
                   ELSE SUM(CASE WHEN avg_score IS NULL THEN 0 ELSE avg_score * page_count END)
                        / SUM(CASE WHEN avg_score IS NULL THEN 0 ELSE page_count END)
              END AS score_moyen
         FROM scan_sessions
        WHERE analyzed_at >= ? AND gamme IS NOT NULL
        GROUP BY gamme
        ORDER BY analyses DESC
        LIMIT ?`,
      [depuis, limite],
    );
  }

  // ── Gouvernance ───────────────────────────────────────────────────────────

  /** Lignes du journal dont l'identité a déjà été retirée. */
  async lignesAnonymisees(): Promise<number> {
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM audit_log WHERE actor_id IS NULL AND actor_name IS NULL`,
    );
    return Number(ligne?.total ?? 0);
  }

  /** Lignes encore identifiantes ET au-delà du délai — celles qui restent à traiter. */
  async lignesEnAttente(avant: string): Promise<number> {
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM audit_log
        WHERE created_at < ? AND (actor_id IS NOT NULL OR actor_name IS NOT NULL
                                  OR ip_address IS NOT NULL)`,
      [avant],
    );
    return Number(ligne?.total ?? 0);
  }

  /**
   * Retire l'identité des lignes antérieures à `avant`.
   *
   * Trois colonnes, et elles seules : l'identifiant, le nom, l'adresse IP.
   * L'action, sa cible et son horodatage RESTENT — ce sont eux qui font du
   * journal une preuve, et les effacer reviendrait à prétendre que rien ne
   * s'est passé.
   *
   * `LIMIT` borne le verrou : sur un journal volumineux, une seule requête
   * bloquerait la table pendant tout le passage.
   */
  anonymiser(avant: string, lot: number): Promise<number> {
    return this.db.execute(
      `UPDATE audit_log
          SET actor_id = NULL, actor_name = NULL, ip_address = NULL
        WHERE created_at < ?
          AND (actor_id IS NOT NULL OR actor_name IS NOT NULL OR ip_address IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT ?`,
      [avant, lot],
    );
  }
}
