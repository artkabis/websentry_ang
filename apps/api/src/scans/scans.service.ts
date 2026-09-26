import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  SESSION_PAGE_LIMIT,
  comparePages,
  siteIdentityKey,
  type ComparablePage,
  type ScanIngest,
  type ScanPage,
  type ScanPageList,
  type ScanSearchQuery,
  type ScanStats,
  type SessionComparison,
  type SessionPage,
  type SessionReport,
  type SiteList,
  type SiteSession,
  type SiteSummary,
} from '@websentry/shared';
import {
  ScanRepository,
  type ComparablePageRow,
  type IngestInput,
  type ScanPageReportRow,
  type ScanPageRow,
  type SessionPageRow,
  type SessionRow,
  type SiteSummaryRow,
} from '../database/repositories/scan.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { ScanTrashService } from './scan-trash.service.js';
import {
  ScanPageNotFoundError,
  ScanReportPurgedError,
  ScanSessionNotFoundError,
  SessionsNotComparableError,
} from './scan.errors.js';
import {
  decodeJson,
  toAnalyzedAt,
  toCheckSummary,
  toInt,
  toIso,
  toProfileSnapshot,
  toReportState,
  toScore,
  toSiteMetadata,
} from './scan.mapper.js';

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/** Contexte d'une opération traçable. */
export interface ScanActor {
  actorId: string | null;
  actorName: string;
  ipAddress: string | null;
}

/**
 * Durée de vie du cache des statistiques.
 *
 * Les statistiques agrègent la table entière — quatre balayages complets. Sans
 * cache, un écran d'administration ouvert par trois personnes suffit à peser sur
 * la base. Une minute est assez courte pour que le chiffre reste vrai et assez
 * longue pour absorber les rafraîchissements d'un tableau de bord.
 */
const STATS_TTL_MS = 60_000;

/** Bornes de la comparaison — au-delà, l'appariement n'est plus lisible à l'écran. */
const COMPARE_PAGE_LIMIT = 2000;

/**
 * Historique des scans — lecture, comparaison, suppression.
 *
 * Deux principes structurent le module :
 *
 *   • **Le résumé des critères survit au rapport.** La rétention efface les
 *     rapports complets, jamais `check_summary`. C'est ce qui permet de comparer
 *     deux audits vieux de deux ans, longtemps après que leur détail a disparu.
 *   • **Un rapport purgé n'est pas un rapport introuvable.** La distinction
 *     remonte jusqu'au code HTTP (410 et non 404) : dire « ça n'existe pas »
 *     d'une donnée qu'on a soi-même supprimée envoie l'utilisateur chercher un
 *     bug qui n'existe pas.
 */
@Injectable()
export class ScansService {
  private readonly logger = new Logger(ScansService.name);
  private statsCache: { value: ScanStats; expiresAt: number } | null = null;

  constructor(
    private readonly repo: ScanRepository,
    private readonly audit: AuditService,
    private readonly corbeille: ScanTrashService,
  ) {}

  private assertAvailable(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException('Historique des scans indisponible');
    }
  }

  // ── Recherche ──────────────────────────────────────────────────────────────

  /** Liste plate des pages analysées — la vue de recherche fine. */
  async searchPages(params: ScanSearchQuery): Promise<ScanPageList> {
    this.assertAvailable();
    const offset = (params.page - 1) * params.limit;

    // Le décompte d'abord : quand il est nul, la seconde requête ne rendrait
    // rien et coûterait pourtant la même jointure.
    const total = await this.repo.countPages(params);
    const rows = total === 0 ? [] : await this.repo.searchPages(params, params.limit, offset);

    return {
      total,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(total / params.limit),
      scans: rows.map(row => this.toScanPage(row)),
    };
  }

  /** Liste des sites, chacun résumé par sa session la plus récente. */
  async listSites(params: ScanSearchQuery): Promise<SiteList> {
    this.assertAvailable();
    const offset = (params.page - 1) * params.limit;

    const total = await this.repo.countSites(params);
    const rows = total === 0 ? [] : await this.repo.listSites(params, params.limit, offset);

    return {
      total,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(total / params.limit),
      sites: rows.map(row => this.toSiteSummary(row)),
    };
  }

  /** Toutes les sessions d'un site, de la plus récente à la plus ancienne. */
  async listSiteSessions(domain: string, gamme: string | null): Promise<SiteSession[]> {
    this.assertAvailable();
    const rows = await this.repo.listSiteSessions(domain, gamme);
    return rows.map(row => ({
      sessionId: row.id,
      pageCount: Number(row.page_count),
      avgScore: toScore(row.avg_score),
      minScore: toScore(row.min_score),
      maxScore: toScore(row.max_score),
      analyzedAt: toAnalyzedAt(row.analyzed_at),
      durationMs: toInt(row.duration_ms),
      launchedBy: row.launched_by,
    }));
  }

  // ── Détail ─────────────────────────────────────────────────────────────────

  /**
   * Rapport complet d'une page.
   *
   * Trois issues distinctes, là où la v1 n'en avait que deux : la page n'existe
   * pas (404), son rapport a été purgé (410, avec la date), ou le rapport est
   * servi.
   */
  async getPageReport(pageId: string): Promise<{ scan: ScanPage; report: unknown }> {
    this.assertAvailable();
    const row = await this.repo.findPageWithReport(pageId);
    if (!row) throw new ScanPageNotFoundError();

    const report = await this.readReport(row);
    // Le résumé part AVEC le refus : c'est ce que le message promet, et un lien
    // ouvert directement n'a rien d'autre sous la main.
    if (report === null) {
      throw new ScanReportPurgedError(toIso(row.report_purged_at), this.toScanPage(row));
    }

    return { scan: this.toScanPage(row), report };
  }

  /** Détail d'une session : ses pages et leurs rapports, dans la limite fixée. */
  async getSessionReport(sessionId: string): Promise<SessionReport> {
    this.assertAvailable();
    const session = await this.repo.findSession(sessionId);
    if (!session) throw new ScanSessionNotFoundError();

    // Une page de plus que la limite : c'est ce qui permet de savoir qu'on
    // tronque SANS compter la session entière au préalable.
    const rows = await this.repo.listSessionPages(sessionId, SESSION_PAGE_LIMIT + 1);
    const truncated = rows.length > SESSION_PAGE_LIMIT;
    const kept = truncated ? rows.slice(0, SESSION_PAGE_LIMIT) : rows;

    const pages = await Promise.all(kept.map(row => this.toSessionPage(row)));

    return {
      ...this.toSessionHeader(session),
      truncated,
      pages,
    };
  }

  /**
   * Détail d'une session, restreint à son auteur.
   *
   * Un testeur consulte SES scans sans détenir `history:read`. Le refus est un
   * **404 et non un 403** : répondre « interdit » confirmerait que la session
   * existe, et permettrait d'énumérer les audits des autres comptes en
   * distinguant les deux réponses.
   */
  async getOwnSessionReport(
    sessionId: string,
    username: string,
    isAdmin: boolean,
  ): Promise<SessionReport> {
    this.assertAvailable();
    const session = await this.repo.findSession(sessionId);
    if (!session) throw new ScanSessionNotFoundError();
    if (!isAdmin && session.launched_by !== username) throw new ScanSessionNotFoundError();
    return this.getSessionReport(sessionId);
  }

  /**
   * Compare deux sessions du même site.
   *
   * L'ordre des arguments ne compte pas pour l'appelant : le scan le plus ANCIEN
   * devient toujours la référence, le plus récent la cible. Un delta négatif
   * signifie donc toujours « ça a baissé », quel que soit l'ordre des liens sur
   * lesquels l'utilisateur a cliqué.
   */
  async compareSessions(firstId: string, secondId: string): Promise<SessionComparison> {
    this.assertAvailable();

    const [first, second] = await Promise.all([
      this.repo.findSession(firstId),
      this.repo.findSession(secondId),
    ]);
    if (!first || !second) throw new ScanSessionNotFoundError();
    if (first.site_id !== second.site_id) throw new SessionsNotComparableError();

    const firstAt = toAnalyzedAt(first.analyzed_at);
    const secondAt = toAnalyzedAt(second.analyzed_at);
    const [base, target] = firstAt <= secondAt ? [first, second] : [second, first];

    const [basePages, targetPages] = await Promise.all([
      this.repo.listComparablePages(base.id, COMPARE_PAGE_LIMIT),
      this.repo.listComparablePages(target.id, COMPARE_PAGE_LIMIT),
    ]);

    const { pages, summary } = comparePages(
      basePages.map(row => this.toComparablePage(row)),
      targetPages.map(row => this.toComparablePage(row)),
    );

    const baseScore = toScore(base.avg_score);
    const targetScore = toScore(target.avg_score);

    return {
      base: this.toComparisonSide(base),
      target: this.toComparisonSide(target),
      scoreDelta:
        baseScore != null && targetScore != null
          ? Math.round((targetScore - baseScore) * 10) / 10
          : null,
      summary,
      pages,
    };
  }

  // ── Statistiques ───────────────────────────────────────────────────────────

  /** Statistiques agrégées, servies depuis un cache d'une minute. */
  async getStats(): Promise<ScanStats> {
    this.assertAvailable();

    const now = Date.now();
    if (this.statsCache && this.statsCache.expiresAt > now) return this.statsCache.value;

    const [summary, sites, sessions, byGamme, buckets, topDomains] = await Promise.all([
      this.repo.statsSummary(),
      this.repo.countRows('sites'),
      this.repo.countRows('scan_sessions'),
      this.repo.statsByGamme(),
      this.repo.statsScoreBuckets(),
      this.repo.statsTopDomains(10),
    ]);

    const value: ScanStats = {
      total: Number(summary?.total ?? 0),
      sites,
      sessions,
      inline: Number(summary?.inline ?? 0),
      compressed: Number(summary?.compressed ?? 0),
      purged: Number(summary?.purged ?? 0),
      avgScore: toScore(summary?.avg_score ?? null),
      oldest: toIso(summary?.oldest ?? null),
      newest: toIso(summary?.newest ?? null),
      storageBytesGz: Number(summary?.storage_gz ?? 0),
      byGamme: byGamme.map(row => ({
        gamme: row.gamme,
        count: Number(row.count),
        avgScore: toScore(row.avg_score),
      })),
      scoreDistribution: {
        good: Number(buckets?.good ?? 0),
        warning: Number(buckets?.warning ?? 0),
        critical: Number(buckets?.critical ?? 0),
        unknown: Number(buckets?.unknown ?? 0),
      },
      topDomains: topDomains.map(row => ({
        domain: row.domain,
        count: Number(row.count),
        avgScore: toScore(row.avg_score),
      })),
      computedAt: new Date(now).toISOString(),
    };

    this.statsCache = { value, expiresAt: now + STATS_TTL_MS };
    return value;
  }

  /** Invalide le cache — appelé après toute suppression, qui rend les chiffres faux. */
  private invalidateStats(): void {
    this.statsCache = null;
  }

  // ── Suppression ────────────────────────────────────────────────────────────

  /**
   * Supprime des pages, puis réconcilie les sessions touchées.
   *
   * Sans réconciliation, une session continuerait d'annoncer un nombre de pages
   * et une moyenne qu'elle n'a plus — des chiffres faux affichés en tête de
   * liste, ce qui est pire qu'une absence de chiffres.
   */
  async deletePages(pageIds: readonly string[], actor: ScanActor): Promise<number> {
    this.assertAvailable();

    const sessionIds = await this.repo.findSessionIdsForPages(pageIds);
    const deleted = await this.repo.deletePages(pageIds);
    if (deleted > 0) {
      await this.repo.reconcileSessions(sessionIds);
      await this.repo.deleteOrphanSites();
      this.invalidateStats();
    }

    await this.audit.record({
      action: 'scans.delete_pages',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: { requested: pageIds.length, deleted },
    });
    return deleted;
  }

  /** Supprime un site entier — couple (domaine, gamme) — et toutes ses sessions. */
  async deleteSite(domain: string, gamme: string | null, actor: ScanActor): Promise<number> {
    this.assertAvailable();

    // Le décompte se fait AVANT : après la cascade, les pages n'existent plus et
    // le nombre rendu à l'utilisateur serait nécessairement zéro.
    const pageCount = await this.repo.countPagesForSite(domain, gamme);
    // L'archivage AUSSI : après la cascade il n'y a plus rien à capturer. Son
    // échec interrompt la suppression — mieux vaut un geste refusé qu'un
    // effacement sans filet.
    const trashId = await this.corbeille.archiverSite(domain, gamme, actor);
    const removed = await this.repo.deleteSite(domain, gamme);
    if (removed > 0) this.invalidateStats();

    await this.audit.record({
      action: 'scans.delete_site',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: {
        identity: siteIdentityKey(domain, gamme),
        pages: pageCount,
        sites: removed,
        trashId,
      },
    });
    return pageCount;
  }

  /** Supprime toutes les gammes d'un domaine — plusieurs sites peuvent le partager. */
  async deleteDomain(domain: string, actor: ScanActor): Promise<number> {
    this.assertAvailable();

    const pageCount = await this.repo.countPagesForDomain(domain);
    const trashId = await this.corbeille.archiver({ scope: 'domain', domain }, actor);
    const removed = await this.repo.deleteDomain(domain);
    if (removed > 0) this.invalidateStats();

    await this.audit.record({
      action: 'scans.delete_domain',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: { domain, pages: pageCount, sites: removed, trashId },
    });
    return pageCount;
  }

  /** Supprime une session complète ; le site disparaît s'il devient orphelin. */
  async deleteSession(sessionId: string, actor: ScanActor): Promise<number> {
    this.assertAvailable();

    const session = await this.repo.findSession(sessionId);
    if (!session) throw new ScanSessionNotFoundError();

    const pageCount = await this.repo.countPagesForSession(sessionId);
    const trashId = await this.corbeille.archiver(
      {
        scope: 'session',
        sessionId,
        siteId: session.site_id,
        domain: session.domain,
        gamme: session.gamme,
      },
      actor,
    );
    await this.repo.deleteSession(sessionId);
    // La cascade a effacé les pages ; le site peut n'avoir plus aucune session.
    await this.repo.deleteOrphanSites();
    this.invalidateStats();

    await this.audit.record({
      action: 'scans.delete_session',
      actorId: actor.actorId,
      actorName: actor.actorName,
      ipAddress: actor.ipAddress,
      details: { sessionId, domain: session.domain, pages: pageCount, trashId },
    });
    return pageCount;
  }

  // ── Écriture ───────────────────────────────────────────────────────────────

  /**
   * Enregistre une session d'analyse.
   *
   * Appelée EN PROCESS par le module d'analyse — aucun endpoint ne l'expose.
   * L'historique n'a pas à accepter d'écriture venue de l'extérieur : ce serait
   * offrir à un compte compromis le moyen de fabriquer un passé.
   */
  async record(input: ScanIngest): Promise<void> {
    if (!this.repo.available) {
      // La persistance ne doit JAMAIS faire échouer l'analyse qui l'a demandée :
      // un historique indisponible dégrade la traçabilité, pas le service rendu.
      this.logger.warn('Historique indisponible — session non enregistrée');
      return;
    }

    const scores = input.pages
      .map(page => page.globalScore)
      .filter((score): score is number => score != null);
    const analyzedAt = input.pages
      .map(page => page.analyzedAt)
      .reduce((latest, current) => (current > latest ? current : latest));

    const payload: IngestInput = {
      sessionId: input.sessionId,
      siteId: randomUUID(),
      domain: input.domain,
      gamme: input.gamme,
      epj: input.epj,
      platform: input.platform,
      siteAlias: input.siteAlias,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      launchedBy: input.launchedBy,
      durationMs: input.durationMs,
      profileSnapshot: input.profileSnapshot ? JSON.stringify(input.profileSnapshot) : null,
      analyzedAt: toSqlDateTime(analyzedAt),
      pageCount: input.pages.length,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      minScore: scores.length ? Math.min(...scores) : null,
      maxScore: scores.length ? Math.max(...scores) : null,
      pages: input.pages.map(page => ({
        id: randomUUID(),
        url: page.url,
        domain: input.domain,
        globalScore: page.globalScore,
        statusCode: page.statusCode,
        analyzedAt: toSqlDateTime(page.analyzedAt),
        durationMs: page.durationMs,
        checkSummary: JSON.stringify(page.checkSummary),
        report: page.report == null ? null : JSON.stringify(page.report),
      })),
    };

    await this.repo.ingestSession(payload);
    this.invalidateStats();
  }

  // ── Conversions ────────────────────────────────────────────────────────────

  private toScanPage(row: ScanPageRow): ScanPage {
    return {
      id: row.id,
      sessionId: row.session_id,
      url: row.url,
      domain: row.domain,
      gamme: row.gamme,
      epj: row.epj,
      platform: row.platform,
      globalScore: toScore(row.global_score),
      statusCode: toInt(row.status_code),
      analyzedAt: toAnalyzedAt(row.analyzed_at),
      durationMs: toInt(row.duration_ms),
      checkSummary: toCheckSummary(row.check_summary),
      metadata: toSiteMetadata(row.metadata),
      launchedBy: row.launched_by,
      reportState: toReportState(row),
    };
  }

  private toSiteSummary(row: SiteSummaryRow): SiteSummary {
    return {
      siteId: row.site_id,
      domain: row.domain,
      gamme: row.gamme,
      epj: row.epj,
      lastSessionId: row.last_session_id,
      pageCount: Number(row.page_count ?? 0),
      avgScore: toScore(row.avg_score),
      minScore: toScore(row.min_score),
      maxScore: toScore(row.max_score),
      lastScan: toAnalyzedAt(row.last_scan),
      sessionCount: Number(row.session_count ?? 0),
      launchedBy: row.launched_by,
      metadata: toSiteMetadata(row.metadata),
    };
  }

  private toSessionHeader(row: SessionRow): Omit<SessionReport, 'truncated' | 'pages'> {
    return {
      sessionId: row.id,
      siteId: row.site_id,
      domain: row.domain,
      gamme: row.gamme,
      epj: row.epj,
      platform: row.platform,
      launchedBy: row.launched_by,
      analyzedAt: toAnalyzedAt(row.analyzed_at),
      durationMs: toInt(row.duration_ms),
      pageCount: Number(row.page_count),
      avgScore: toScore(row.avg_score),
      minScore: toScore(row.min_score),
      maxScore: toScore(row.max_score),
      profileSnapshot: toProfileSnapshot(row.profile_snapshot),
    };
  }

  private toComparisonSide(row: SessionRow): SessionComparison['base'] {
    return {
      sessionId: row.id,
      analyzedAt: toAnalyzedAt(row.analyzed_at),
      avgScore: toScore(row.avg_score),
      pageCount: Number(row.page_count),
    };
  }

  private toComparablePage(row: ComparablePageRow): ComparablePage {
    return {
      url: row.url,
      globalScore: toScore(row.global_score),
      checkSummary: toCheckSummary(row.check_summary),
    };
  }

  private async toSessionPage(row: SessionPageRow): Promise<SessionPage> {
    const state = toReportState(row);
    let report: unknown = null;
    let error: string | null = null;

    if (state !== 'purged') {
      try {
        report = await this.readReport(row);
      } catch (err) {
        // Un rapport illisible ne doit pas emporter toute la session : les
        // autres pages restent consultables, et l'erreur est dite sur celle-là.
        error = 'Rapport illisible';
        this.logger.warn(`Rapport illisible pour la page ${row.id} : ${(err as Error).message}`);
      }
    }

    return {
      id: row.id,
      url: row.url,
      globalScore: toScore(row.global_score),
      statusCode: toInt(row.status_code),
      analyzedAt: toAnalyzedAt(row.analyzed_at),
      checkSummary: toCheckSummary(row.check_summary),
      reportState: state,
      report,
      error,
    };
  }

  /**
   * Relit le rapport d'une ligne, décompressé si besoin.
   *
   * Rend `null` quand rien n'est stocké — c'est l'appelant qui décide si cela
   * vaut un 410 (lecture d'une page) ou une simple mention (détail de session).
   */
  private async readReport(
    row: Pick<ScanPageReportRow, 'report' | 'report_gz' | 'is_compressed'>,
  ): Promise<unknown> {
    if (row.report_gz != null) {
      const buffer = Buffer.isBuffer(row.report_gz)
        ? row.report_gz
        : Buffer.from(row.report_gz, 'base64');
      const json = (await gunzipAsync(buffer)).toString('utf8');
      return decodeJson(json);
    }
    if (row.report != null) return decodeJson(row.report);
    return null;
  }
}

/** Compresse un rapport — niveau maximal, le travail se fait hors requête servie. */
export function compressReport(json: string): Promise<Buffer> {
  return gzipAsync(Buffer.from(json, 'utf8'), { level: 9 });
}

/**
 * Convertit un ISO 8601 en `DATETIME` MariaDB, en UTC.
 *
 * Le passage par `Date` normalise le décalage : `2026-06-04T12:00:00+02:00`
 * devient `2026-06-04 10:00:00`, ce que la colonne stocke réellement.
 */
export function toSqlDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}
