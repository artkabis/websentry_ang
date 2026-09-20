import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { ScanReportPurgedError, ScansApi } from './scans.api';

const BASE = '/api/v1';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';

/** Rapport minimal conforme au schéma partagé. */
function analysisReport(over: Record<string, unknown> = {}) {
  return {
    analyzeId: '33333333-3333-4333-8333-333333333333',
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore: 4,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    htmlSize: 1000,
    httpHeaders: {},
    dudaParams: null,
    checks: {},
    ...over,
  };
}

function scanPage(over: Record<string, unknown> = {}) {
  return {
    id: PAGE,
    sessionId: SESSION_A,
    url: 'https://exemple.fr/',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: null,
    platform: 'duda',
    globalScore: 4,
    statusCode: 200,
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1000,
    checkSummary: { METAS: 'pass' },
    metadata: null,
    launchedBy: 'alice',
    reportState: 'inline',
    ...over,
  };
}

describe('ScansApi', () => {
  let api: ScansApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        ScansApi,
      ],
    });
    api = TestBed.inject(ScansApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('chaîne de requête', () => {
    it('OMET les valeurs vides', async () => {
      // Un `gamme=` vide n'exprime aucun filtre, et le backend refuse ce qu'il
      // ne connaît pas : l'envoyer transformerait « pas de filtre » en erreur.
      const promise = api.listSites({ domain: 'exemple.fr', gamme: '', epj: undefined });
      const req = http.expectOne(r => r.url === `${BASE}/scans/sites`);

      expect(req.request.params.get('domain')).toBe('exemple.fr');
      expect(req.request.params.has('gamme')).toBe(false);
      expect(req.request.params.has('epj')).toBe(false);

      req.flush({ total: 0, page: 1, limit: 20, pages: 0, sites: [] });
      await promise;
    });

    it('sérialise les nombres', async () => {
      const promise = api.searchPages({ page: 2, limit: 50, scoreMin: 3 });
      const req = http.expectOne(r => r.url === `${BASE}/scans`);

      expect(req.request.params.get('page')).toBe('2');
      expect(req.request.params.get('scoreMin')).toBe('3');

      req.flush({ total: 0, page: 2, limit: 50, pages: 0, scans: [] });
      await promise;
    });
  });

  describe('validation des réponses', () => {
    it('valide une liste de pages contre le schéma partagé', async () => {
      const promise = api.searchPages();
      http
        .expectOne(r => r.url === `${BASE}/scans`)
        .flush({ total: 1, page: 1, limit: 20, pages: 1, scans: [scanPage()] });

      const result = await promise;
      expect(result.scans[0]?.id).toBe(PAGE);
      expect(result.total).toBe(1);
    });

    it('REJETTE une réponse qui a dérivé du contrat', async () => {
      // Détecter la dérive à la frontière vaut mieux que la découvrir trois
      // écrans plus loin sous la forme d'un champ manquant.
      const promise = api.searchPages();
      http
        .expectOne(r => r.url === `${BASE}/scans`)
        .flush({
          total: 1,
          page: 1,
          limit: 20,
          pages: 1,
          scans: [scanPage({ globalScore: 16.4 })],
        });

      await expect(promise).rejects.toThrow();
    });

    it('valide une liste de sites', async () => {
      const promise = api.listSites();
      http
        .expectOne(r => r.url === `${BASE}/scans/sites`)
        .flush({
          total: 1,
          page: 1,
          limit: 20,
          pages: 1,
          sites: [
            {
              siteId: SITE,
              domain: 'exemple.fr',
              gamme: 'premium',
              epj: null,
              lastSessionId: SESSION_A,
              pageCount: 3,
              avgScore: 4,
              minScore: 3,
              maxScore: 5,
              lastScan: '2026-06-04T10:00:00.000Z',
              sessionCount: 2,
              launchedBy: 'alice',
              metadata: null,
            },
          ],
        });

      const result = await promise;
      expect(result.sites[0]?.domain).toBe('exemple.fr');
    });

    it('valide une comparaison', async () => {
      const promise = api.compare(SESSION_A, SESSION_B);
      http.expectOne(`${BASE}/scans/sessions/${SESSION_A}/compare/${SESSION_B}`).flush({
        base: {
          sessionId: SESSION_A,
          analyzedAt: '2026-06-01T10:00:00.000Z',
          avgScore: 4,
          pageCount: 1,
        },
        target: {
          sessionId: SESSION_B,
          analyzedAt: '2026-06-10T10:00:00.000Z',
          avgScore: 2,
          pageCount: 1,
        },
        scoreDelta: -2,
        summary: { added: 0, removed: 0, degraded: 1, improved: 0, unchanged: 0 },
        pages: [],
      });

      const result = await promise;
      expect(result.scoreDelta).toBe(-2);
    });
  });

  describe('historique d’un site', () => {
    it('transmet la gamme quand elle existe', async () => {
      const promise = api.siteSessions('exemple.fr', 'premium');
      const req = http.expectOne(r => r.url === `${BASE}/scans/sites/sessions`);

      expect(req.request.params.get('gamme')).toBe('premium');
      req.flush([]);
      await promise;
    });

    it('N’ENVOIE PAS de gamme vide pour un site sans gamme', async () => {
      const promise = api.siteSessions('exemple.fr', null);
      const req = http.expectOne(r => r.url === `${BASE}/scans/sites/sessions`);

      expect(req.request.params.has('gamme')).toBe(false);
      req.flush([]);
      await promise;
    });
  });

  describe('rapport d’une page', () => {
    it('rend le rapport ET le scan qui le porte', async () => {
      const promise = api.pageReport(PAGE);
      http.expectOne(`${BASE}/scans/${PAGE}`).flush({ scan: scanPage(), report: analysisReport() });

      const { scan, report } = await promise;
      expect(scan.url).toBe('https://exemple.fr/');
      expect(report.analyzeId).toBe('33333333-3333-4333-8333-333333333333');
    });

    it('REFUSE un rapport qui ne respecte pas le contrat partagé', async () => {
      // Une API qui dérive doit être détectée à la frontière, pas trois écrans
      // plus loin sous la forme d'un champ manquant.
      const promise = api.pageReport(PAGE);
      http.expectOne(`${BASE}/scans/${PAGE}`).flush({ scan: scanPage(), report: { checks: {} } });

      await expect(promise).rejects.toThrow();
    });

    it('EMPORTE le résumé quand le 410 le fournit', async () => {
      // Un lien ouvert directement — signet, message d'un collègue — n'a rien
      // d'autre sous la main pour montrer ce que le scan valait.
      const promise = api.pageReport(PAGE);
      http.expectOne(`${BASE}/scans/${PAGE}`).flush(
        {
          details: { purgedAt: '2026-01-15T03:00:00.000Z', scan: scanPage({ globalScore: 3.5 }) },
        },
        { status: 410, statusText: 'Gone' },
      );

      const error = (await promise.catch((e: unknown) => e)) as ScanReportPurgedError;
      expect(error.scan?.globalScore).toBe(3.5);
    });

    it('reste utilisable quand le 410 n’emporte PAS de résumé', async () => {
      const promise = api.pageReport(PAGE);
      http
        .expectOne(`${BASE}/scans/${PAGE}`)
        .flush({ details: { purgedAt: null } }, { status: 410, statusText: 'Gone' });

      const error = (await promise.catch((e: unknown) => e)) as ScanReportPurgedError;
      expect(error.scan).toBeNull();
    });

    it('TRADUIT un 410 en erreur typée, avec sa date', async () => {
      const promise = api.pageReport(PAGE);
      http.expectOne(`${BASE}/scans/${PAGE}`).flush(
        {
          statusCode: 410,
          error: 'Rapport purgé',
          message: 'purgé',
          details: { purgedAt: '2026-01-15T03:00:00.000Z' },
        },
        { status: 410, statusText: 'Gone' },
      );

      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScanReportPurgedError);
      expect((error as ScanReportPurgedError).purgedAt).toBe('2026-01-15T03:00:00.000Z');
      expect((error as Error).message).toContain('2026-01-15');
    });

    it('accepte un 410 sans date — les lignes purgées par la v1 n’en ont pas', async () => {
      const promise = api.pageReport(PAGE);
      http
        .expectOne(`${BASE}/scans/${PAGE}`)
        .flush({ details: {} }, { status: 410, statusText: 'Gone' });

      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScanReportPurgedError);
      expect((error as ScanReportPurgedError).purgedAt).toBeNull();
    });

    it('RELAIE les autres erreurs telles quelles', async () => {
      // Les traduire masquerait leur nature (403, 404, 503…) au composant qui
      // doit les présenter.
      const promise = api.pageReport(PAGE);
      http
        .expectOne(`${BASE}/scans/${PAGE}`)
        .flush({ message: 'Interdit' }, { status: 403, statusText: 'Forbidden' });

      const error = await promise.catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(ScanReportPurgedError);
    });
  });

  describe('suppressions', () => {
    it('envoie les identifiants dans le corps', async () => {
      const promise = api.deletePages([PAGE]);
      const req = http.expectOne(`${BASE}/scans`);

      expect(req.request.method).toBe('DELETE');
      expect(req.request.body).toEqual({ ids: [PAGE] });
      req.flush({ deleted: 1 });

      await expect(promise).resolves.toBe(1);
    });

    it('TRANSMET une gamme nulle explicitement', async () => {
      // L'omettre ferait refuser la requête ; la traiter comme « toutes
      // gammes » effacerait bien plus que demandé.
      const promise = api.deleteSite('exemple.fr', null);
      const req = http.expectOne(`${BASE}/scans/sites`);

      expect(req.request.body).toEqual({ domain: 'exemple.fr', gamme: null });
      req.flush({ deleted: 3 });
      await promise;
    });

    it('supprime une session', async () => {
      const promise = api.deleteSession(SESSION_A);
      http.expectOne(`${BASE}/scans/sessions/${SESSION_A}`).flush({ deleted: 2 });
      await expect(promise).resolves.toBe(2);
    });
  });

  describe('statistiques et session', () => {
    it('valide les statistiques', async () => {
      const promise = api.stats();
      http.expectOne(`${BASE}/scans/stats`).flush({
        total: 10,
        sites: 2,
        sessions: 3,
        inline: 5,
        compressed: 4,
        purged: 1,
        avgScore: 3.5,
        oldest: null,
        newest: null,
        storageBytesGz: 0,
        byGamme: [],
        scoreDistribution: { good: 1, warning: 2, critical: 3, unknown: 4 },
        topDomains: [],
        computedAt: '2026-06-04T10:00:00.000Z',
      });

      await expect(promise).resolves.toMatchObject({ total: 10, purged: 1 });
    });

    it('valide le détail d’une session', async () => {
      const promise = api.session(SESSION_A);
      http.expectOne(`${BASE}/scans/sessions/${SESSION_A}`).flush({
        sessionId: SESSION_A,
        siteId: SITE,
        domain: 'exemple.fr',
        gamme: null,
        epj: null,
        platform: null,
        launchedBy: null,
        analyzedAt: '2026-06-04T10:00:00.000Z',
        durationMs: null,
        pageCount: 0,
        avgScore: null,
        minScore: null,
        maxScore: null,
        truncated: false,
        profileSnapshot: null,
        pages: [],
      });

      await expect(promise).resolves.toMatchObject({ sessionId: SESSION_A });
    });
  });
});
