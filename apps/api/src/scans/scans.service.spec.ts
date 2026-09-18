import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { ScanSearchQuerySchema, type ScanIngest } from '@websentry/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { ScanRepository } from '../database/repositories/scan.repository.js';
import { ScansService } from './scans.service.js';
import {
  ScanPageNotFoundError,
  ScanReportPurgedError,
  ScanSessionNotFoundError,
  SessionsNotComparableError,
} from './scan.errors.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const PAGE_A = '33333333-3333-4333-8333-333333333333';
const SITE_A = '44444444-4444-4444-8444-444444444444';

function query(overrides: Record<string, unknown> = {}) {
  return ScanSearchQuerySchema.parse(overrides);
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAGE_A,
    session_id: SESSION_A,
    url: 'https://exemple.fr/',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: 'ABC',
    platform: 'duda',
    global_score: '4.20',
    status_code: 200,
    analyzed_at: '2026-06-04 10:00:00',
    duration_ms: 1200,
    check_summary: '{"METAS":"pass"}',
    metadata: null,
    launched_by: 'alice',
    is_compressed: 0,
    has_report: 1,
    report_purged_at: null,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_A,
    site_id: SITE_A,
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: null,
    platform: 'duda',
    page_count: 2,
    avg_score: '4.00',
    min_score: '3.00',
    max_score: '5.00',
    analyzed_at: '2026-06-04 10:00:00',
    duration_ms: 5000,
    launched_by: 'alice',
    profile_snapshot: null,
    ...overrides,
  };
}

function build(available = true) {
  const repo = {
    available,
    countPages: vi.fn().mockResolvedValue(0),
    searchPages: vi.fn().mockResolvedValue([]),
    countSites: vi.fn().mockResolvedValue(0),
    listSites: vi.fn().mockResolvedValue([]),
    listSiteSessions: vi.fn().mockResolvedValue([]),
    findPageWithReport: vi.fn().mockResolvedValue(null),
    findSession: vi.fn().mockResolvedValue(null),
    listSessionPages: vi.fn().mockResolvedValue([]),
    listComparablePages: vi.fn().mockResolvedValue([]),
    findSessionIdsForPages: vi.fn().mockResolvedValue([]),
    deletePages: vi.fn().mockResolvedValue(0),
    countPagesForSite: vi.fn().mockResolvedValue(0),
    countPagesForDomain: vi.fn().mockResolvedValue(0),
    countPagesForSession: vi.fn().mockResolvedValue(0),
    deleteSite: vi.fn().mockResolvedValue(0),
    deleteDomain: vi.fn().mockResolvedValue(0),
    deleteSession: vi.fn().mockResolvedValue(1),
    reconcileSessions: vi.fn().mockResolvedValue(undefined),
    deleteOrphanSites: vi.fn().mockResolvedValue(0),
    statsSummary: vi.fn().mockResolvedValue(null),
    countRows: vi.fn().mockResolvedValue(0),
    statsByGamme: vi.fn().mockResolvedValue([]),
    statsScoreBuckets: vi.fn().mockResolvedValue(null),
    statsTopDomains: vi.fn().mockResolvedValue([]),
    ingestSession: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new ScansService(
    repo as unknown as ScanRepository,
    audit as unknown as AuditService,
  );
  return { service, repo, audit };
}

const actor = { actorId: 'u1', actorName: 'alice', ipAddress: '10.0.0.1' };

describe('ScansService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('disponibilité', () => {
    it.each([
      ['searchPages', (s: ScansService) => s.searchPages(query())],
      ['listSites', (s: ScansService) => s.listSites(query())],
      ['getStats', (s: ScansService) => s.getStats()],
      ['getPageReport', (s: ScansService) => s.getPageReport(PAGE_A)],
      ['getSessionReport', (s: ScansService) => s.getSessionReport(SESSION_A)],
    ])('refuse %s quand la base est absente', async (_label, call) => {
      const off = build(false);
      await expect(call(off.service)).rejects.toThrow('Historique des scans indisponible');
    });
  });

  describe('searchPages', () => {
    it('ÉVITE la seconde requête quand le décompte est nul', async () => {
      // Elle ne rendrait rien et coûterait pourtant la même jointure.
      const result = await t.service.searchPages(query());
      expect(t.repo.searchPages).not.toHaveBeenCalled();
      expect(result).toMatchObject({ total: 0, pages: 0, scans: [] });
    });

    it('calcule l’offset depuis la page demandée', async () => {
      t.repo.countPages.mockResolvedValue(100);
      await t.service.searchPages(query({ page: 3, limit: 20 }));
      expect(t.repo.searchPages).toHaveBeenCalledWith(expect.anything(), 20, 40);
    });

    it('arrondit le nombre de pages au supérieur', async () => {
      t.repo.countPages.mockResolvedValue(41);
      t.repo.searchPages.mockResolvedValue([pageRow()]);
      const result = await t.service.searchPages(query({ limit: 20 }));
      expect(result.pages).toBe(3);
    });

    it('traduit une ligne en page du contrat', async () => {
      t.repo.countPages.mockResolvedValue(1);
      t.repo.searchPages.mockResolvedValue([pageRow()]);
      const result = await t.service.searchPages(query());
      expect(result.scans[0]).toEqual({
        id: PAGE_A,
        sessionId: SESSION_A,
        url: 'https://exemple.fr/',
        domain: 'exemple.fr',
        gamme: 'premium',
        epj: 'ABC',
        platform: 'duda',
        globalScore: 4.2,
        statusCode: 200,
        analyzedAt: '2026-06-04T10:00:00.000Z',
        durationMs: 1200,
        checkSummary: { METAS: 'pass' },
        metadata: null,
        launchedBy: 'alice',
        reportState: 'inline',
      });
    });

    it('signale l’état purgé sans rapatrier le rapport', async () => {
      t.repo.countPages.mockResolvedValue(1);
      t.repo.searchPages.mockResolvedValue([pageRow({ has_report: 0 })]);
      const result = await t.service.searchPages(query());
      expect(result.scans[0]?.reportState).toBe('purged');
    });
  });

  describe('listSites', () => {
    it('traduit une ligne de site', async () => {
      t.repo.countSites.mockResolvedValue(1);
      t.repo.listSites.mockResolvedValue([
        {
          site_id: SITE_A,
          domain: 'exemple.fr',
          gamme: null,
          epj: null,
          last_session_id: SESSION_A,
          page_count: 12,
          avg_score: '3.75',
          min_score: '2.00',
          max_score: '5.00',
          last_scan: '2026-06-04 10:00:00',
          session_count: 4,
          launched_by: 'alice',
          metadata: null,
        },
      ]);
      const result = await t.service.listSites(query());
      expect(result.sites[0]).toMatchObject({
        siteId: SITE_A,
        avgScore: 3.8,
        sessionCount: 4,
        lastScan: '2026-06-04T10:00:00.000Z',
      });
    });

    it('n’interroge pas la seconde requête sur un décompte nul', async () => {
      const result = await t.service.listSites(query());
      expect(t.repo.listSites).not.toHaveBeenCalled();
      expect(result.sites).toEqual([]);
    });

    it('compte zéro session quand la colonne est absente', async () => {
      t.repo.countSites.mockResolvedValue(1);
      t.repo.listSites.mockResolvedValue([
        {
          site_id: SITE_A,
          domain: 'exemple.fr',
          gamme: null,
          epj: null,
          last_session_id: null,
          page_count: null,
          avg_score: null,
          min_score: null,
          max_score: null,
          last_scan: '2026-06-04 10:00:00',
          session_count: null,
          launched_by: null,
          metadata: null,
        },
      ]);
      const result = await t.service.listSites(query());
      expect(result.sites[0]?.sessionCount).toBe(0);
    });

    it('accepte un site sans aucune session', async () => {
      t.repo.countSites.mockResolvedValue(1);
      t.repo.listSites.mockResolvedValue([
        {
          site_id: SITE_A,
          domain: 'exemple.fr',
          gamme: null,
          epj: null,
          last_session_id: null,
          page_count: null,
          avg_score: null,
          min_score: null,
          max_score: null,
          last_scan: '2026-06-04 10:00:00',
          session_count: 0,
          launched_by: null,
          metadata: null,
        },
      ]);
      const result = await t.service.listSites(query());
      expect(result.sites[0]).toMatchObject({ lastSessionId: null, pageCount: 0, avgScore: null });
    });
  });

  describe('listSiteSessions', () => {
    it('traduit les sessions du site', async () => {
      t.repo.listSiteSessions.mockResolvedValue([sessionRow()]);
      const [session] = await t.service.listSiteSessions('exemple.fr', 'premium');
      expect(session).toEqual({
        sessionId: SESSION_A,
        pageCount: 2,
        avgScore: 4,
        minScore: 3,
        maxScore: 5,
        analyzedAt: '2026-06-04T10:00:00.000Z',
        durationMs: 5000,
        launchedBy: 'alice',
      });
    });

    it('transmet la gamme nulle telle quelle', async () => {
      await t.service.listSiteSessions('exemple.fr', null);
      expect(t.repo.listSiteSessions).toHaveBeenCalledWith('exemple.fr', null);
    });
  });

  describe('getPageReport', () => {
    it('rend le rapport stocké en clair', async () => {
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({ report: '{"checks":{"METAS":{}}}', report_gz: null }),
      );
      const result = await t.service.getPageReport(PAGE_A);
      expect(result.report).toEqual({ checks: { METAS: {} } });
      expect(result.scan.id).toBe(PAGE_A);
    });

    it('décompresse un rapport gzip', async () => {
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({ is_compressed: 1, report: null, report_gz: gzipSync(Buffer.from('{"a":1}')) }),
      );
      const result = await t.service.getPageReport(PAGE_A);
      expect(result.report).toEqual({ a: 1 });
    });

    it('accepte un gzip encodé en base64 — forme héritée de la v1', async () => {
      const base64 = gzipSync(Buffer.from('{"a":1}')).toString('base64');
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({ is_compressed: 1, report: null, report_gz: base64 }),
      );
      await expect(t.service.getPageReport(PAGE_A)).resolves.toMatchObject({ report: { a: 1 } });
    });

    it('lève 404 quand la page n’existe pas', async () => {
      await expect(t.service.getPageReport(PAGE_A)).rejects.toBeInstanceOf(ScanPageNotFoundError);
    });

    it('lève 410 — et non 404 — quand le rapport a été purgé', async () => {
      // Un 404 enverrait l'utilisateur chercher une donnée que l'application a
      // elle-même supprimée.
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({
          has_report: 0,
          report: null,
          report_gz: null,
          report_purged_at: '2026-01-15 03:00:00',
        }),
      );
      await expect(t.service.getPageReport(PAGE_A)).rejects.toBeInstanceOf(ScanReportPurgedError);
    });

    it('porte la date de purge dans l’erreur', async () => {
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({
          has_report: 0,
          report: null,
          report_gz: null,
          report_purged_at: '2026-01-15 03:00:00',
        }),
      );
      const error = await t.service.getPageReport(PAGE_A).catch((e: ScanReportPurgedError) => e);
      expect((error as ScanReportPurgedError).purgedAt).toBe('2026-01-15T03:00:00.000Z');
    });

    it('accepte une purge antérieure au suivi de la date', async () => {
      // Les lignes déjà purgées par la v1 n'ont pas de date : on le dit, plutôt
      // que d'en inventer une.
      t.repo.findPageWithReport.mockResolvedValue(
        pageRow({ has_report: 0, report: null, report_gz: null, report_purged_at: null }),
      );
      const error = await t.service.getPageReport(PAGE_A).catch((e: ScanReportPurgedError) => e);
      expect((error as ScanReportPurgedError).purgedAt).toBeNull();
    });
  });

  describe('getSessionReport', () => {
    it('lève 404 pour une session inconnue', async () => {
      await expect(t.service.getSessionReport(SESSION_A)).rejects.toBeInstanceOf(
        ScanSessionNotFoundError,
      );
    });

    it('assemble l’en-tête et les pages', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow());
      t.repo.listSessionPages.mockResolvedValue([
        {
          id: PAGE_A,
          url: 'https://exemple.fr/',
          global_score: '4.00',
          status_code: 200,
          analyzed_at: '2026-06-04 10:00:00',
          check_summary: '{"METAS":"pass"}',
          report: '{"ok":true}',
          report_gz: null,
          is_compressed: 0,
          report_purged_at: null,
        },
      ]);
      const result = await t.service.getSessionReport(SESSION_A);
      expect(result.truncated).toBe(false);
      expect(result.pages[0]).toMatchObject({ reportState: 'inline', report: { ok: true } });
    });

    it('marque la session tronquée au-delà de la limite', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow());
      const many = Array.from({ length: 201 }, (_, i) => ({
        id: PAGE_A,
        url: `https://exemple.fr/${i}`,
        global_score: null,
        status_code: null,
        analyzed_at: '2026-06-04 10:00:00',
        check_summary: '{}',
        report: null,
        report_gz: null,
        is_compressed: 0,
        report_purged_at: null,
      }));
      t.repo.listSessionPages.mockResolvedValue(many);
      const result = await t.service.getSessionReport(SESSION_A);
      expect(result.truncated).toBe(true);
      expect(result.pages).toHaveLength(200);
    });

    it('n’EMPORTE PAS la session entière pour un rapport illisible', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow());
      t.repo.listSessionPages.mockResolvedValue([
        {
          id: PAGE_A,
          url: 'https://exemple.fr/',
          global_score: null,
          status_code: null,
          analyzed_at: '2026-06-04 10:00:00',
          check_summary: '{}',
          report: null,
          report_gz: Buffer.from('ceci n’est pas du gzip'),
          is_compressed: 1,
          report_purged_at: null,
        },
      ]);
      const result = await t.service.getSessionReport(SESSION_A);
      expect(result.pages[0]).toMatchObject({ report: null, error: 'Rapport illisible' });
    });

    it('n’essaie pas de lire un rapport purgé', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow());
      t.repo.listSessionPages.mockResolvedValue([
        {
          id: PAGE_A,
          url: 'https://exemple.fr/',
          global_score: null,
          status_code: null,
          analyzed_at: '2026-06-04 10:00:00',
          check_summary: '{}',
          report: null,
          report_gz: null,
          is_compressed: 0,
          report_purged_at: '2026-01-15 03:00:00',
        },
      ]);
      const result = await t.service.getSessionReport(SESSION_A);
      expect(result.pages[0]).toMatchObject({ reportState: 'purged', report: null, error: null });
    });
  });

  describe('getOwnSessionReport', () => {
    it('sert la session à son auteur', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow({ launched_by: 'alice' }));
      await expect(t.service.getOwnSessionReport(SESSION_A, 'alice', false)).resolves.toMatchObject(
        { sessionId: SESSION_A },
      );
    });

    it('sert la session à un administrateur', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow({ launched_by: 'bob' }));
      await expect(t.service.getOwnSessionReport(SESSION_A, 'alice', true)).resolves.toBeDefined();
    });

    it('répond 404 — et non 403 — pour la session d’autrui', async () => {
      // Un 403 confirmerait l'existence de la session et permettrait d'énumérer
      // les audits des autres comptes en distinguant les deux réponses.
      t.repo.findSession.mockResolvedValue(sessionRow({ launched_by: 'bob' }));
      await expect(t.service.getOwnSessionReport(SESSION_A, 'alice', false)).rejects.toBeInstanceOf(
        ScanSessionNotFoundError,
      );
    });

    it('répond 404 pour une session inexistante', async () => {
      await expect(t.service.getOwnSessionReport(SESSION_A, 'alice', false)).rejects.toBeInstanceOf(
        ScanSessionNotFoundError,
      );
    });
  });

  describe('compareSessions', () => {
    const comparable = (url: string, score: string | null, summary: string) => ({
      url,
      global_score: score,
      check_summary: summary,
    });

    it('refuse deux sessions de sites différents', async () => {
      // La comparaison « réussirait » en annonçant que toutes les pages ont
      // disparu et que toutes les autres sont apparues : valide et trompeur.
      t.repo.findSession
        .mockResolvedValueOnce(sessionRow({ id: SESSION_A, site_id: SITE_A }))
        .mockResolvedValueOnce(sessionRow({ id: SESSION_B, site_id: 'autre-site' }));
      await expect(t.service.compareSessions(SESSION_A, SESSION_B)).rejects.toBeInstanceOf(
        SessionsNotComparableError,
      );
    });

    it('lève 404 si l’une des sessions manque', async () => {
      t.repo.findSession.mockResolvedValueOnce(sessionRow()).mockResolvedValueOnce(null);
      await expect(t.service.compareSessions(SESSION_A, SESSION_B)).rejects.toBeInstanceOf(
        ScanSessionNotFoundError,
      );
    });

    it('prend TOUJOURS le scan le plus ancien pour référence', async () => {
      // Ainsi un delta négatif signifie « ça a baissé », quel que soit l'ordre
      // des liens sur lesquels l'utilisateur a cliqué.
      t.repo.findSession
        .mockResolvedValueOnce(
          sessionRow({ id: SESSION_A, analyzed_at: '2026-06-10 10:00:00', avg_score: '3.00' }),
        )
        .mockResolvedValueOnce(
          sessionRow({ id: SESSION_B, analyzed_at: '2026-06-01 10:00:00', avg_score: '4.00' }),
        );
      const result = await t.service.compareSessions(SESSION_A, SESSION_B);
      expect(result.base.sessionId).toBe(SESSION_B);
      expect(result.target.sessionId).toBe(SESSION_A);
      expect(result.scoreDelta).toBe(-1);
    });

    it('produit le même résultat quel que soit l’ordre des arguments', async () => {
      const older = sessionRow({
        id: SESSION_B,
        analyzed_at: '2026-06-01 10:00:00',
        avg_score: '4.00',
      });
      const newer = sessionRow({
        id: SESSION_A,
        analyzed_at: '2026-06-10 10:00:00',
        avg_score: '3.00',
      });
      t.repo.findSession.mockImplementation((id: string) =>
        Promise.resolve(id === SESSION_A ? newer : older),
      );
      const direct = await t.service.compareSessions(SESSION_A, SESSION_B);
      const inverse = await t.service.compareSessions(SESSION_B, SESSION_A);
      expect(direct).toEqual(inverse);
    });

    it('rend un diff des pages', async () => {
      t.repo.findSession
        .mockResolvedValueOnce(sessionRow({ id: SESSION_A, analyzed_at: '2026-06-01 10:00:00' }))
        .mockResolvedValueOnce(sessionRow({ id: SESSION_B, analyzed_at: '2026-06-10 10:00:00' }));
      t.repo.listComparablePages
        .mockResolvedValueOnce([comparable('https://exemple.fr/', '4.00', '{"METAS":"pass"}')])
        .mockResolvedValueOnce([comparable('https://exemple.fr/', '2.00', '{"METAS":"fail"}')]);
      const result = await t.service.compareSessions(SESSION_A, SESSION_B);
      expect(result.summary.degraded).toBe(1);
      expect(result.pages[0]).toMatchObject({ scoreDelta: -2, degraded: 1 });
    });

    it('ne calcule pas de delta quand une moyenne manque', async () => {
      t.repo.findSession
        .mockResolvedValueOnce(
          sessionRow({ id: SESSION_A, analyzed_at: '2026-06-01 10:00:00', avg_score: null }),
        )
        .mockResolvedValueOnce(sessionRow({ id: SESSION_B, analyzed_at: '2026-06-10 10:00:00' }));
      const result = await t.service.compareSessions(SESSION_A, SESSION_B);
      expect(result.scoreDelta).toBeNull();
    });

    it('ne rapatrie PAS les rapports complets', async () => {
      // Les charger multiplierait par mille le volume, et échouerait justement
      // sur les scans anciens dont le rapport est purgé alors que le résumé
      // survit.
      t.repo.findSession.mockResolvedValue(sessionRow());
      await t.service.compareSessions(SESSION_A, SESSION_B);
      expect(t.repo.listSessionPages).not.toHaveBeenCalled();
      expect(t.repo.listComparablePages).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStats', () => {
    it('agrège les décomptes', async () => {
      t.repo.statsSummary.mockResolvedValue({
        total: 100,
        inline: 60,
        compressed: 30,
        purged: 10,
        avg_score: '3.75',
        oldest: '2026-01-01 00:00:00',
        newest: '2026-06-04 10:00:00',
        storage_gz: '4096',
      });
      t.repo.countRows.mockResolvedValue(7);
      t.repo.statsScoreBuckets.mockResolvedValue({
        good: 40,
        warning: 30,
        critical: 20,
        unknown: 10,
      });
      const stats = await t.service.getStats();
      expect(stats).toMatchObject({
        total: 100,
        sites: 7,
        sessions: 7,
        avgScore: 3.8,
        storageBytesGz: 4096,
        scoreDistribution: { good: 40, warning: 30, critical: 20, unknown: 10 },
      });
    });

    it('traduit la répartition par gamme et le palmarès de domaines', async () => {
      t.repo.statsByGamme.mockResolvedValue([{ gamme: 'premium', count: '50', avg_score: '4.06' }]);
      t.repo.statsTopDomains.mockResolvedValue([
        { domain: 'exemple.fr', count: '12', avg_score: null },
      ]);
      const stats = await t.service.getStats();
      expect(stats.byGamme).toEqual([{ gamme: 'premium', count: 50, avgScore: 4.1 }]);
      expect(stats.topDomains).toEqual([{ domain: 'exemple.fr', count: 12, avgScore: null }]);
    });

    it('tient sur une base vide', async () => {
      const stats = await t.service.getStats();
      expect(stats).toMatchObject({ total: 0, avgScore: null, oldest: null, newest: null });
    });

    it('SERT le cache au second appel', async () => {
      // Chaque calcul balaie la table entière : sans cache, un tableau de bord
      // ouvert par trois personnes suffit à peser sur la base.
      await t.service.getStats();
      await t.service.getStats();
      expect(t.repo.statsSummary).toHaveBeenCalledTimes(1);
    });

    it('INVALIDE le cache après une suppression', async () => {
      await t.service.getStats();
      t.repo.deletePages.mockResolvedValue(3);
      await t.service.deletePages([PAGE_A], actor);
      await t.service.getStats();
      expect(t.repo.statsSummary).toHaveBeenCalledTimes(2);
    });

    it('expire le cache passé son délai', async () => {
      vi.useFakeTimers();
      try {
        await t.service.getStats();
        vi.advanceTimersByTime(61_000);
        await t.service.getStats();
        expect(t.repo.statsSummary).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deletePages', () => {
    it('réconcilie les sessions touchées et efface les sites orphelins', async () => {
      // Sans réconciliation, une session continuerait d'annoncer un nombre de
      // pages qu'elle n'a plus — un chiffre faux en tête de liste.
      t.repo.findSessionIdsForPages.mockResolvedValue([SESSION_A]);
      t.repo.deletePages.mockResolvedValue(2);
      const deleted = await t.service.deletePages([PAGE_A], actor);
      expect(deleted).toBe(2);
      expect(t.repo.reconcileSessions).toHaveBeenCalledWith([SESSION_A]);
      expect(t.repo.deleteOrphanSites).toHaveBeenCalled();
    });

    it('ne réconcilie rien quand rien n’a été supprimé', async () => {
      await t.service.deletePages([PAGE_A], actor);
      expect(t.repo.reconcileSessions).not.toHaveBeenCalled();
    });

    it('journalise l’écart entre demandé et supprimé', async () => {
      t.repo.deletePages.mockResolvedValue(1);
      await t.service.deletePages([PAGE_A, SESSION_B], actor);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'scans.delete_pages',
          details: { requested: 2, deleted: 1 },
        }),
      );
    });
  });

  describe('deleteSite', () => {
    it('compte les pages AVANT la cascade', async () => {
      // Après, elles n'existent plus : le nombre rendu serait nécessairement nul.
      t.repo.countPagesForSite.mockResolvedValue(12);
      t.repo.deleteSite.mockResolvedValue(1);
      await expect(t.service.deleteSite('exemple.fr', 'premium', actor)).resolves.toBe(12);
    });

    it('n’invalide pas les statistiques quand aucun site n’a été effacé', async () => {
      await t.service.getStats();
      t.repo.deleteSite.mockResolvedValue(0);
      await t.service.deleteSite('inconnu.fr', null, actor);
      await t.service.getStats();
      expect(t.repo.statsSummary).toHaveBeenCalledTimes(1);
    });

    it('journalise la clé d’identité visée', async () => {
      await t.service.deleteSite('exemple.fr', null, actor);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'scans.delete_site',
          details: expect.objectContaining({ identity: 'exemple.fr|' }),
        }),
      );
    });
  });

  describe('deleteDomain', () => {
    it('n’invalide pas les statistiques quand aucun domaine n’a été effacé', async () => {
      await t.service.getStats();
      await t.service.deleteDomain('inconnu.fr', actor);
      await t.service.getStats();
      expect(t.repo.statsSummary).toHaveBeenCalledTimes(1);
    });

    it('rend le nombre de pages effacées, toutes gammes confondues', async () => {
      t.repo.countPagesForDomain.mockResolvedValue(40);
      t.repo.deleteDomain.mockResolvedValue(3);
      await expect(t.service.deleteDomain('exemple.fr', actor)).resolves.toBe(40);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: { domain: 'exemple.fr', pages: 40, sites: 3 } }),
      );
    });
  });

  describe('deleteSession', () => {
    it('lève 404 pour une session inconnue', async () => {
      await expect(t.service.deleteSession(SESSION_A, actor)).rejects.toBeInstanceOf(
        ScanSessionNotFoundError,
      );
    });

    it('efface le site devenu orphelin', async () => {
      t.repo.findSession.mockResolvedValue(sessionRow());
      t.repo.countPagesForSession.mockResolvedValue(5);
      await expect(t.service.deleteSession(SESSION_A, actor)).resolves.toBe(5);
      expect(t.repo.deleteOrphanSites).toHaveBeenCalled();
    });
  });

  describe('record', () => {
    const ingest: ScanIngest = {
      sessionId: SESSION_A,
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: 'ABC',
      platform: 'duda',
      siteAlias: 'exemple',
      metadata: null,
      launchedBy: 'alice',
      durationMs: 4200,
      profileSnapshot: null,
      pages: [
        {
          url: 'https://exemple.fr/a',
          globalScore: 4,
          statusCode: 200,
          analyzedAt: '2026-06-04T10:00:00.000Z',
          durationMs: 1000,
          checkSummary: { METAS: 'pass' },
          report: { ok: true },
        },
        {
          url: 'https://exemple.fr/b',
          globalScore: 2,
          statusCode: 200,
          analyzedAt: '2026-06-04T10:05:00.000Z',
          durationMs: 1000,
          checkSummary: { METAS: 'fail' },
          report: null,
        },
      ],
    };

    it('calcule les agrégats de la session', async () => {
      await t.service.record(ingest);
      const [payload] = t.repo.ingestSession.mock.calls[0] as [Record<string, unknown>];
      expect(payload).toMatchObject({ pageCount: 2, avgScore: 3, minScore: 2, maxScore: 4 });
    });

    it('horodate la session sur la page la PLUS RÉCENTE', async () => {
      await t.service.record(ingest);
      const [payload] = t.repo.ingestSession.mock.calls[0] as [{ analyzedAt: string }];
      expect(payload.analyzedAt).toBe('2026-06-04 10:05:00');
    });

    it('horodate la session correctement quelle que soit l’ORDRE des pages', async () => {
      // Les pages d'un batch n'arrivent pas triées : prendre la dernière du
      // tableau daterait la session d'un instant qui n'est pas le plus récent.
      await t.service.record({
        ...ingest,
        pages: [ingest.pages[1]!, ingest.pages[0]!],
      });
      const [payload] = t.repo.ingestSession.mock.calls[0] as [{ analyzedAt: string }];
      expect(payload.analyzedAt).toBe('2026-06-04 10:05:00');
    });

    it('sérialise les métadonnées et l’instantané de profil', async () => {
      await t.service.record({
        ...ingest,
        metadata: { siteAlias: 'exemple' },
        profileSnapshot: { enabledChecks: ['METAS'], enabledSubChecks: [] },
      });
      const [payload] = t.repo.ingestSession.mock.calls[0] as [
        { metadata: string | null; profileSnapshot: string | null },
      ];
      expect(payload.metadata).toBe('{"siteAlias":"exemple"}');
      expect(payload.profileSnapshot).toContain('METAS');
    });

    it('sérialise le rapport, et laisse null quand l’analyse a échoué', async () => {
      await t.service.record(ingest);
      const [payload] = t.repo.ingestSession.mock.calls[0] as [
        { pages: Array<{ report: string | null }> },
      ];
      expect(payload.pages[0]?.report).toBe('{"ok":true}');
      expect(payload.pages[1]?.report).toBeNull();
    });

    it('ignore les scores absents dans la moyenne', async () => {
      await t.service.record({
        ...ingest,
        pages: [{ ...ingest.pages[0]!, globalScore: null }, ingest.pages[1]!],
      });
      const [payload] = t.repo.ingestSession.mock.calls[0] as [{ avgScore: number }];
      expect(payload.avgScore).toBe(2);
    });

    it('accepte une session dont aucune page n’a de score', async () => {
      await t.service.record({
        ...ingest,
        pages: ingest.pages.map(p => ({ ...p, globalScore: null })),
      });
      const [payload] = t.repo.ingestSession.mock.calls[0] as [{ avgScore: number | null }];
      expect(payload.avgScore).toBeNull();
    });

    it('NE FAIT PAS ÉCHOUER l’analyse quand la base est absente', async () => {
      // La persistance dégrade la traçabilité, jamais le service rendu.
      const off = build(false);
      await expect(off.service.record(ingest)).resolves.toBeUndefined();
      expect(off.repo.ingestSession).not.toHaveBeenCalled();
    });
  });
});
