import { Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { siteIdentityKey, type ScanSearchQuery } from '@websentry/shared';
import { DatabaseService, type SqlParam } from '../database.service.js';
import {
  containsPattern,
  pageOrderBy,
  sanitizeFulltextTerm,
  siteOrderBy,
  toDateBound,
} from '../../scans/scan-query.util.js';

// ── Lignes brutes ────────────────────────────────────────────────────────────

export interface ScanPageRow extends RowDataPacket {
  id: string;
  session_id: string;
  url: string;
  domain: string;
  gamme: string | null;
  epj: string | null;
  platform: string | null;
  global_score: string | number | null;
  status_code: number | null;
  analyzed_at: string;
  duration_ms: number | null;
  check_summary: unknown;
  metadata: unknown;
  launched_by: string | null;
  is_compressed: number;
  has_report: number;
  report_purged_at: string | null;
}

export interface ScanPageReportRow extends ScanPageRow {
  report: string | null;
  report_gz: Buffer | string | null;
}

export interface SiteSummaryRow extends RowDataPacket {
  site_id: string;
  domain: string;
  gamme: string | null;
  epj: string | null;
  last_session_id: string | null;
  page_count: number | null;
  avg_score: string | number | null;
  min_score: string | number | null;
  max_score: string | number | null;
  last_scan: string;
  session_count: number;
  launched_by: string | null;
  metadata: unknown;
}

export interface SessionRow extends RowDataPacket {
  id: string;
  site_id: string;
  domain: string;
  gamme: string | null;
  epj: string | null;
  platform: string | null;
  page_count: number;
  avg_score: string | number | null;
  min_score: string | number | null;
  max_score: string | number | null;
  analyzed_at: string;
  duration_ms: number | null;
  launched_by: string | null;
  profile_snapshot: unknown;
}

export interface SessionPageRow extends RowDataPacket {
  id: string;
  url: string;
  global_score: string | number | null;
  status_code: number | null;
  analyzed_at: string;
  check_summary: unknown;
  report: string | null;
  report_gz: Buffer | string | null;
  is_compressed: number;
  report_purged_at: string | null;
}

export interface ComparablePageRow extends RowDataPacket {
  url: string;
  global_score: string | number | null;
  check_summary: unknown;
}

export interface CountRow extends RowDataPacket {
  total: number;
}

export interface StatsSummaryRow extends RowDataPacket {
  total: number;
  inline: number | null;
  compressed: number | null;
  purged: number | null;
  avg_score: string | number | null;
  oldest: string | null;
  newest: string | null;
  storage_gz: string | number | null;
}

export interface GammeStatRow extends RowDataPacket {
  gamme: string;
  count: number;
  avg_score: string | number | null;
}

export interface DomainStatRow extends RowDataPacket {
  domain: string;
  count: number;
  avg_score: string | number | null;
}

export interface ScoreBucketRow extends RowDataPacket {
  good: number | null;
  warning: number | null;
  critical: number | null;
  unknown: number | null;
}

// ── Fragments partagés ───────────────────────────────────────────────────────

/**
 * Colonnes d'une page en LISTE — le rapport complet en est volontairement absent.
 *
 * `has_report` répond « ce rapport est-il encore lisible ? » sans transporter
 * ses dizaines de kilo-octets : une liste de 100 pages qui ramènerait les
 * rapports pèserait plusieurs mégaoctets pour n'en afficher aucun.
 */
const PAGE_LIST_COLUMNS = `p.id, p.session_id, p.url, p.domain, si.gamme, si.epj, ss.platform,
       p.global_score, p.status_code, p.analyzed_at, p.duration_ms,
       p.check_summary, si.metadata, ss.launched_by,
       p.is_compressed, p.report_purged_at,
       (p.report IS NOT NULL OR p.report_gz IS NOT NULL) AS has_report`;

const PAGE_JOIN = `FROM scan_pages p
      JOIN scan_sessions ss ON ss.id = p.session_id
      JOIN sites si ON si.id = ss.site_id`;

/**
 * Chaque site joint à sa session la plus récente.
 *
 * `LEFT JOIN` et non `JOIN` : un site dont toutes les sessions ont été
 * supprimées doit rester visible, sinon il devient invisible ET indestructible
 * depuis l'interface.
 */
const SITE_JOIN = `FROM sites si
      LEFT JOIN (
        SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.site_id
                                       ORDER BY s.analyzed_at DESC, s.id DESC) AS rn
          FROM scan_sessions s
      ) ss ON ss.site_id = si.id AND ss.rn = 1`;

interface Filters {
  where: string;
  values: SqlParam[];
}

/**
 * Accès aux tables de l'historique des scans.
 *
 * Tout ce qui vient de l'appelant circule en paramètre lié. Les deux seules
 * chaînes injectées dans le texte des requêtes — la clause `ORDER BY` et les
 * marqueurs `?` d'une liste d'identifiants — sont dérivées de tables fermées et
 * de la LONGUEUR d'un tableau, jamais de son contenu.
 */
@Injectable()
export class ScanRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  // ── Construction des filtres ───────────────────────────────────────────────

  /**
   * Filtres communs aux deux vues.
   *
   * `scoreColumn` et `dateColumn` diffèrent selon la vue : une page porte son
   * propre score, un site porte la moyenne de sa dernière session. Appliquer le
   * filtre « score ≥ 4 » à la mauvaise colonne donnerait des résultats
   * plausibles mais faux, ce qui est pire qu'une erreur visible.
   */
  private buildFilters(
    params: ScanSearchQuery,
    opts: { scoreColumn: string; dateColumn: string; sessionColumn?: string },
  ): Filters {
    const clauses: string[] = [];
    const values: SqlParam[] = [];

    const term = params.q?.trim();
    if (term) {
      const fulltext = sanitizeFulltextTerm(term);
      if (fulltext) {
        clauses.push('MATCH(si.domain, si.epj) AGAINST (? IN BOOLEAN MODE)');
        values.push(fulltext);
      } else {
        // Terme trop court pour l'index plein texte (« fr », « 42 ») : le
        // refuser laisserait croire qu'aucun site ne correspond.
        clauses.push('(si.domain LIKE ? OR si.epj LIKE ?)');
        values.push(containsPattern(term), containsPattern(term));
      }
    }

    if (params.domain?.trim()) {
      clauses.push('si.domain LIKE ?');
      values.push(containsPattern(params.domain));
    }
    if (params.gamme) {
      clauses.push('si.gamme = ?');
      values.push(params.gamme);
    }
    if (params.epj?.trim()) {
      clauses.push('si.epj LIKE ?');
      values.push(containsPattern(params.epj));
    }
    if (params.scoreMin != null) {
      clauses.push(`${opts.scoreColumn} >= ?`);
      values.push(params.scoreMin);
    }
    if (params.scoreMax != null) {
      clauses.push(`${opts.scoreColumn} <= ?`);
      values.push(params.scoreMax);
    }
    if (params.dateFrom) {
      clauses.push(`${opts.dateColumn} >= ?`);
      values.push(toDateBound(params.dateFrom, 'start'));
    }
    if (params.dateTo) {
      clauses.push(`${opts.dateColumn} <= ?`);
      values.push(toDateBound(params.dateTo, 'end'));
    }
    if (params.sessionId && opts.sessionColumn) {
      clauses.push(`${opts.sessionColumn} = ?`);
      values.push(params.sessionId);
    }

    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  }

  // ── Lecture : pages ────────────────────────────────────────────────────────

  async countPages(params: ScanSearchQuery): Promise<number> {
    const { where, values } = this.buildFilters(params, {
      scoreColumn: 'p.global_score',
      dateColumn: 'p.analyzed_at',
      sessionColumn: 'p.session_id',
    });
    const row = await this.db.queryOne<CountRow>(
      `SELECT COUNT(*) AS total ${PAGE_JOIN} ${where}`,
      values,
    );
    return Number(row?.total ?? 0);
  }

  searchPages(params: ScanSearchQuery, limit: number, offset: number): Promise<ScanPageRow[]> {
    const { where, values } = this.buildFilters(params, {
      scoreColumn: 'p.global_score',
      dateColumn: 'p.analyzed_at',
      sessionColumn: 'p.session_id',
    });
    return this.db.query<ScanPageRow>(
      `SELECT ${PAGE_LIST_COLUMNS} ${PAGE_JOIN} ${where}
        ${pageOrderBy(params.sort, params.order)}
        LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
  }

  findPageWithReport(pageId: string): Promise<ScanPageReportRow | null> {
    return this.db.queryOne<ScanPageReportRow>(
      `SELECT ${PAGE_LIST_COLUMNS}, p.report, p.report_gz
         ${PAGE_JOIN}
        WHERE p.id = ?
        LIMIT 1`,
      [pageId],
    );
  }

  // ── Lecture : sites ────────────────────────────────────────────────────────

  async countSites(params: ScanSearchQuery): Promise<number> {
    const { where, values } = this.buildFilters(params, {
      scoreColumn: 'ss.avg_score',
      dateColumn: 'ss.analyzed_at',
    });
    const row = await this.db.queryOne<CountRow>(
      `SELECT COUNT(*) AS total ${SITE_JOIN} ${where}`,
      values,
    );
    return Number(row?.total ?? 0);
  }

  listSites(params: ScanSearchQuery, limit: number, offset: number): Promise<SiteSummaryRow[]> {
    const { where, values } = this.buildFilters(params, {
      scoreColumn: 'ss.avg_score',
      dateColumn: 'ss.analyzed_at',
    });
    return this.db.query<SiteSummaryRow>(
      `SELECT si.id AS site_id, si.domain, si.gamme, si.epj, si.metadata,
              ss.id AS last_session_id, ss.page_count, ss.avg_score, ss.min_score, ss.max_score,
              ss.launched_by,
              COALESCE(ss.analyzed_at, si.last_seen) AS last_scan,
              (SELECT COUNT(*) FROM scan_sessions c WHERE c.site_id = si.id) AS session_count
         ${SITE_JOIN} ${where}
        ${siteOrderBy(params.sort, params.order)}
        LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
  }

  /** Sessions d'un site (couple domaine + gamme), de la plus récente à la plus ancienne. */
  listSiteSessions(domain: string, gamme: string | null): Promise<SessionRow[]> {
    return this.db.query<SessionRow>(
      `SELECT ss.id, ss.site_id, si.domain, ss.gamme, ss.epj, ss.platform,
              ss.page_count, ss.avg_score, ss.min_score, ss.max_score,
              ss.analyzed_at, ss.duration_ms, ss.launched_by, ss.profile_snapshot
         FROM scan_sessions ss
         JOIN sites si ON si.id = ss.site_id
        WHERE si.identity_key = ?
        ORDER BY ss.analyzed_at DESC, ss.id ASC`,
      [siteIdentityKey(domain, gamme)],
    );
  }

  // ── Lecture : sessions ─────────────────────────────────────────────────────

  findSession(sessionId: string): Promise<SessionRow | null> {
    return this.db.queryOne<SessionRow>(
      `SELECT ss.id, ss.site_id, si.domain, ss.gamme, ss.epj, ss.platform,
              ss.page_count, ss.avg_score, ss.min_score, ss.max_score,
              ss.analyzed_at, ss.duration_ms, ss.launched_by, ss.profile_snapshot
         FROM scan_sessions ss
         JOIN sites si ON si.id = ss.site_id
        WHERE ss.id = ?
        LIMIT 1`,
      [sessionId],
    );
  }

  /** Pages d'une session, rapports compris. `limit` borne ce qu'une session peut coûter. */
  listSessionPages(sessionId: string, limit: number): Promise<SessionPageRow[]> {
    return this.db.query<SessionPageRow>(
      `SELECT p.id, p.url, p.global_score, p.status_code, p.analyzed_at,
              p.check_summary, p.report, p.report_gz, p.is_compressed, p.report_purged_at
         FROM scan_pages p
        WHERE p.session_id = ?
        ORDER BY p.analyzed_at ASC, p.id ASC
        LIMIT ?`,
      [sessionId, limit],
    );
  }

  /**
   * Pages d'une session, réduites au strict nécessaire pour la comparaison.
   *
   * Comparer deux sessions ne demande que l'URL, le score et le résumé des
   * critères. Charger les rapports complets multiplierait par mille le volume
   * transféré — et échouerait précisément sur les scans anciens, dont le
   * rapport est justement purgé alors que le résumé, lui, survit.
   */
  listComparablePages(sessionId: string, limit: number): Promise<ComparablePageRow[]> {
    return this.db.query<ComparablePageRow>(
      `SELECT p.url, p.global_score, p.check_summary
         FROM scan_pages p
        WHERE p.session_id = ?
        ORDER BY p.analyzed_at ASC, p.id ASC
        LIMIT ?`,
      [sessionId, limit],
    );
  }

  // ── Suppression ────────────────────────────────────────────────────────────

  /** Sessions concernées par une liste de pages — à réconcilier après suppression. */
  async findSessionIdsForPages(pageIds: readonly string[]): Promise<string[]> {
    if (pageIds.length === 0) return [];
    const rows = await this.db.query<RowDataPacket & { session_id: string }>(
      `SELECT DISTINCT session_id FROM scan_pages WHERE id IN (${placeholders(pageIds.length)})`,
      [...pageIds],
    );
    return rows.map(r => r.session_id);
  }

  deletePages(pageIds: readonly string[]): Promise<number> {
    if (pageIds.length === 0) return Promise.resolve(0);
    return this.db.execute(`DELETE FROM scan_pages WHERE id IN (${placeholders(pageIds.length)})`, [
      ...pageIds,
    ]);
  }

  /**
   * Compte les pages d'un site, par la MÊME jointure que la suppression.
   *
   * La v1 comptait par `scan_pages.domain` mais supprimait par `sites.domain` :
   * deux notions de « domaine » qui divergent dès qu'une page a été rattachée à
   * un site d'un autre nom. Le nombre annoncé à l'utilisateur ne correspondait
   * alors pas à ce qui était réellement effacé.
   */
  async countPagesForSite(domain: string, gamme: string | null): Promise<number> {
    const row = await this.db.queryOne<CountRow>(
      `SELECT COUNT(*) AS total
         FROM scan_pages p
         JOIN scan_sessions ss ON ss.id = p.session_id
         JOIN sites si ON si.id = ss.site_id
        WHERE si.identity_key = ?`,
      [siteIdentityKey(domain, gamme)],
    );
    return Number(row?.total ?? 0);
  }

  async countPagesForDomain(domain: string): Promise<number> {
    const row = await this.db.queryOne<CountRow>(
      `SELECT COUNT(*) AS total
         FROM scan_pages p
         JOIN scan_sessions ss ON ss.id = p.session_id
         JOIN sites si ON si.id = ss.site_id
        WHERE si.domain = ?`,
      [domain],
    );
    return Number(row?.total ?? 0);
  }

  async countPagesForSession(sessionId: string): Promise<number> {
    const row = await this.db.queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM scan_pages WHERE session_id = ?`,
      [sessionId],
    );
    return Number(row?.total ?? 0);
  }

  /** Efface un site et, par cascade, ses sessions et ses pages. */
  deleteSite(domain: string, gamme: string | null): Promise<number> {
    return this.db.execute(`DELETE FROM sites WHERE identity_key = ?`, [
      siteIdentityKey(domain, gamme),
    ]);
  }

  /** Efface toutes les gammes d'un domaine — plusieurs sites peuvent le partager. */
  deleteDomain(domain: string): Promise<number> {
    return this.db.execute(`DELETE FROM sites WHERE domain = ?`, [domain]);
  }

  deleteSession(sessionId: string): Promise<number> {
    return this.db.execute(`DELETE FROM scan_sessions WHERE id = ?`, [sessionId]);
  }

  /**
   * Recalcule les agrégats des sessions citées, puis efface celles devenues
   * vides et les sites devenus orphelins.
   *
   * Sans cela, supprimer des pages laisserait des sessions annonçant un nombre
   * de pages qu'elles n'ont plus, et des sites fantômes en tête de liste.
   */
  async reconcileSessions(sessionIds: readonly string[]): Promise<void> {
    const unique = [...new Set(sessionIds.filter(Boolean))];
    if (unique.length === 0) return;
    const marks = placeholders(unique.length);

    await this.db.execute(
      `UPDATE scan_sessions ss
          JOIN (
            SELECT session_id,
                   COUNT(*) AS page_count,
                   AVG(global_score) AS avg_score,
                   MIN(global_score) AS min_score,
                   MAX(global_score) AS max_score,
                   MAX(analyzed_at)  AS analyzed_at
              FROM scan_pages
             WHERE session_id IN (${marks})
             GROUP BY session_id
          ) agg ON agg.session_id = ss.id
          SET ss.page_count  = agg.page_count,
              ss.avg_score   = agg.avg_score,
              ss.min_score   = agg.min_score,
              ss.max_score   = agg.max_score,
              ss.analyzed_at = agg.analyzed_at`,
      [...unique],
    );

    await this.db.execute(
      `DELETE FROM scan_sessions
        WHERE id IN (${marks})
          AND NOT EXISTS (SELECT 1 FROM scan_pages p WHERE p.session_id = scan_sessions.id)`,
      [...unique],
    );
  }

  /**
   * Efface les sites qui n'ont plus aucune session.
   *
   * Appelé APRÈS toute suppression, y compris celle d'une session entière — cas
   * que la réconciliation ne couvre pas, la session ayant déjà disparu quand on
   * s'y intéresse. Un site sans session reste sinon en tête de liste, sans rien
   * à afficher et sans moyen de le faire disparaître depuis l'interface.
   */
  deleteOrphanSites(): Promise<number> {
    return this.db.execute(
      `DELETE si FROM sites si
        WHERE NOT EXISTS (SELECT 1 FROM scan_sessions ss WHERE ss.site_id = si.id)`,
    );
  }

  // ── Statistiques ───────────────────────────────────────────────────────────

  statsSummary(): Promise<StatsSummaryRow | null> {
    return this.db.queryOne<StatsSummaryRow>(
      `SELECT COUNT(*)                                              AS total,
              SUM(report IS NOT NULL)                               AS inline,
              SUM(is_compressed = 1 AND report_gz IS NOT NULL)      AS compressed,
              SUM(report IS NULL AND report_gz IS NULL)             AS purged,
              AVG(global_score)                                     AS avg_score,
              MIN(analyzed_at)                                      AS oldest,
              MAX(analyzed_at)                                      AS newest,
              COALESCE(SUM(LENGTH(report_gz)), 0)                   AS storage_gz
         FROM scan_pages`,
    );
  }

  async countRows(table: 'sites' | 'scan_sessions'): Promise<number> {
    // `table` ne vient PAS de l'appelant : son type ne laisse que deux valeurs
    // littérales, toutes deux écrites ici.
    const row = await this.db.queryOne<CountRow>(`SELECT COUNT(*) AS total FROM ${table}`);
    return Number(row?.total ?? 0);
  }

  statsByGamme(): Promise<GammeStatRow[]> {
    return this.db.query<GammeStatRow>(
      `SELECT si.gamme AS gamme, COUNT(*) AS count, AVG(p.global_score) AS avg_score
         ${PAGE_JOIN}
        WHERE si.gamme IS NOT NULL
        GROUP BY si.gamme
        ORDER BY count DESC
        LIMIT 50`,
    );
  }

  statsScoreBuckets(): Promise<ScoreBucketRow | null> {
    // Seuils de l'échelle 0–5 : ≥ 4 bon, ≥ 3 à surveiller, en dessous critique.
    return this.db.queryOne<ScoreBucketRow>(
      `SELECT SUM(global_score >= 4)                      AS good,
              SUM(global_score >= 3 AND global_score < 4) AS warning,
              SUM(global_score < 3)                       AS critical,
              SUM(global_score IS NULL)                   AS unknown
         FROM scan_pages`,
    );
  }

  statsTopDomains(limit: number): Promise<DomainStatRow[]> {
    return this.db.query<DomainStatRow>(
      `SELECT domain, COUNT(*) AS count, AVG(global_score) AS avg_score
         FROM scan_pages
        GROUP BY domain
        ORDER BY count DESC
        LIMIT ?`,
      [limit],
    );
  }

  // ── Écriture ───────────────────────────────────────────────────────────────

  /**
   * Enregistre une session complète — site, session et pages — en UNE transaction.
   *
   * L'atomicité n'est pas un luxe ici : une session écrite sans ses pages
   * afficherait un audit vide, et des pages écrites sans leur session seraient
   * inatteignables tout en occupant la place.
   */
  ingestSession(input: IngestInput): Promise<void> {
    return this.db.transaction(async conn => {
      const siteId = await upsertSite(conn, input);
      await insertSession(conn, siteId, input);
      await insertPages(conn, input);
    });
  }
}

// ── Écriture : détail ────────────────────────────────────────────────────────

/** Ce que le repository a besoin de connaître d'une session à enregistrer. */
export interface IngestInput {
  sessionId: string;
  siteId: string;
  domain: string;
  gamme: string | null;
  epj: string | null;
  platform: string | null;
  siteAlias: string | null;
  metadata: string | null;
  launchedBy: string | null;
  durationMs: number | null;
  profileSnapshot: string | null;
  analyzedAt: string;
  pageCount: number;
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  pages: ReadonlyArray<{
    id: string;
    url: string;
    domain: string;
    globalScore: number | null;
    statusCode: number | null;
    analyzedAt: string;
    durationMs: number | null;
    checkSummary: string;
    report: string | null;
  }>;
}

/**
 * Crée le site s'il n'existe pas, et rafraîchit sinon ce qui a pu changer.
 *
 * `INSERT ... ON DUPLICATE KEY UPDATE` sur la clé d'identité générée fait de
 * l'opération un aller-retour unique et ATOMIQUE. Un `SELECT` puis `INSERT`
 * laisserait deux scans lancés en même temps sur le même site créer deux lignes
 * — ou échouer l'un des deux sur la contrainte d'unicité.
 *
 * `first_seen` n'est jamais réécrit : c'est une date de découverte, pas un
 * horodatage de dernière écriture. `last_seen` ne recule pas non plus, pour
 * qu'un scan rejoué sur des données anciennes ne rajeunisse pas le site.
 */
async function upsertSite(conn: PoolConnection, input: IngestInput): Promise<string> {
  await conn.query(
    `INSERT INTO sites (id, domain, gamme, epj, site_alias, metadata, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
          epj        = COALESCE(VALUES(epj), sites.epj),
          site_alias = COALESCE(VALUES(site_alias), sites.site_alias),
          metadata   = COALESCE(VALUES(metadata), sites.metadata),
          last_seen  = GREATEST(sites.last_seen, VALUES(last_seen))`,
    [
      input.siteId,
      input.domain,
      input.gamme,
      input.epj,
      input.siteAlias,
      input.metadata,
      input.analyzedAt,
      input.analyzedAt,
    ],
  );

  // L'UUID retenu est celui de la ligne EXISTANTE quand il y en avait une :
  // `ON DUPLICATE KEY UPDATE` ne remplace pas la clé primaire, et rattacher la
  // session à l'identifiant qu'on vient d'inventer violerait la clé étrangère.
  const [rows] = await conn.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM sites WHERE identity_key = ? LIMIT 1`,
    [siteIdentityKey(input.domain, input.gamme)],
  );
  return rows[0]?.id ?? input.siteId;
}

async function insertSession(
  conn: PoolConnection,
  siteId: string,
  input: IngestInput,
): Promise<void> {
  await conn.query(
    `INSERT INTO scan_sessions
            (id, site_id, gamme, epj, platform, page_count, avg_score, min_score, max_score,
             analyzed_at, duration_ms, launched_by, profile_snapshot, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
            page_count  = VALUES(page_count),
            avg_score   = VALUES(avg_score),
            min_score   = VALUES(min_score),
            max_score   = VALUES(max_score),
            analyzed_at = VALUES(analyzed_at),
            duration_ms = VALUES(duration_ms)`,
    [
      input.sessionId,
      siteId,
      input.gamme,
      input.epj,
      input.platform,
      input.pageCount,
      input.avgScore,
      input.minScore,
      input.maxScore,
      input.analyzedAt,
      input.durationMs,
      input.launchedBy,
      input.profileSnapshot,
      input.metadata,
    ],
  );
}

/**
 * Insère les pages en un seul `INSERT` multi-lignes.
 *
 * Les marqueurs sont dérivés du NOMBRE de pages ; toutes les valeurs restent
 * liées. Un batch sitemap peut compter des milliers de pages : autant d'allers-
 * retours tiendrait la transaction — et donc les verrous — ouverte d'autant.
 */
async function insertPages(conn: PoolConnection, input: IngestInput): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < input.pages.length; i += CHUNK) {
    const chunk = input.pages.slice(i, i + CHUNK);
    const tuples = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values: SqlParam[] = [];
    for (const page of chunk) {
      values.push(
        page.id,
        input.sessionId,
        page.url,
        page.domain,
        page.globalScore,
        page.statusCode,
        page.analyzedAt,
        page.durationMs,
        page.checkSummary,
        page.report,
      );
    }
    await conn.query(
      `INSERT INTO scan_pages
              (id, session_id, url, domain, global_score, status_code,
               analyzed_at, duration_ms, check_summary, report)
            VALUES ${tuples}`,
      values,
    );
  }
}

/** Marqueurs `?` d'une liste — dérivés de la LONGUEUR, jamais du contenu. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
