import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const EDITOR = {
  id: 'u-editor',
  username: 'editeur',
  password: 'MotDePasseEdit!2026',
  rank: RANKS.EDITOR,
};
const TESTER = {
  id: 'u-test',
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

const SITE = '44444444-4444-4444-8444-444444444444';
const SESSION_OLD = '11111111-1111-4111-8111-111111111111';
const SESSION_NEW = '22222222-2222-4222-8222-222222222222';
const PAGE_OLD = '33333333-3333-4333-8333-333333333333';
const PAGE_NEW = '55555555-5555-4555-8555-555555555555';
const PAGE_PURGED = '66666666-6666-4666-8666-666666666666';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe('Historique des scans (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, EDITOR, TESTER]);
    http = request(t.app.getHttpServer());
    seed();
  });

  afterEach(async () => {
    await t.close();
  });

  /** Un site, deux sessions, trois pages — de quoi exercer les trois vues. */
  function seed(): void {
    t.db.scanSites.set(SITE, {
      id: SITE,
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: 'ABC-123',
      metadata: null,
      last_seen: '2026-06-10 10:00:00',
    });

    t.db.scanSessions.set(SESSION_OLD, {
      id: SESSION_OLD,
      site_id: SITE,
      gamme: 'premium',
      epj: 'ABC-123',
      platform: 'duda',
      page_count: 2,
      avg_score: 4,
      min_score: 3,
      max_score: 5,
      analyzed_at: '2026-06-01 10:00:00',
      duration_ms: 4000,
      launched_by: 'testeur',
      profile_snapshot: null,
    });
    t.db.scanSessions.set(SESSION_NEW, {
      id: SESSION_NEW,
      site_id: SITE,
      gamme: 'premium',
      epj: 'ABC-123',
      platform: 'duda',
      page_count: 1,
      avg_score: 2,
      min_score: 2,
      max_score: 2,
      analyzed_at: '2026-06-10 10:00:00',
      duration_ms: 3000,
      launched_by: 'admin',
      profile_snapshot: null,
    });

    t.db.scanPages.set(PAGE_OLD, {
      id: PAGE_OLD,
      session_id: SESSION_OLD,
      url: 'https://exemple.fr/',
      domain: 'exemple.fr',
      global_score: 4,
      status_code: 200,
      analyzed_at: '2026-06-01 10:00:00',
      duration_ms: 1000,
      check_summary: { METAS: 'pass' },
      report: '{"checks":{"METAS":{"status":"pass"}}}',
      report_gz: null,
      is_compressed: 0,
      report_purged_at: null,
    });
    t.db.scanPages.set(PAGE_PURGED, {
      id: PAGE_PURGED,
      session_id: SESSION_OLD,
      url: 'https://exemple.fr/contact',
      domain: 'exemple.fr',
      global_score: 3,
      status_code: 200,
      analyzed_at: '2026-06-01 10:01:00',
      duration_ms: 900,
      check_summary: { METAS: 'warning' },
      report: null,
      report_gz: null,
      is_compressed: 0,
      report_purged_at: '2026-06-05 03:00:00',
    });
    t.db.scanPages.set(PAGE_NEW, {
      id: PAGE_NEW,
      session_id: SESSION_NEW,
      url: 'https://exemple.fr/',
      domain: 'exemple.fr',
      global_score: 2,
      status_code: 200,
      analyzed_at: '2026-06-10 10:00:00',
      duration_ms: 1100,
      check_summary: { METAS: 'fail' },
      report_gz: gzipSync(Buffer.from('{"checks":{"METAS":{"status":"fail"}}}')),
      report: null,
      is_compressed: 1,
      report_purged_at: null,
    });
  }

  async function session(user: { username: string; password: string }) {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: user.username, password: user.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, csrf: cookieValue(cookies, COOKIES.CSRF)! };
  }

  function write(
    method: 'post' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  // ── Recherche ──────────────────────────────────────────────────────────────

  describe('GET /scans', () => {
    it('liste les pages analysées, la plus récente d’abord', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.total).toBe(3);
      expect(res.body.scans[0].id).toBe(PAGE_NEW);
    });

    it('n’expose AUCUN rapport dans la liste', async () => {
      // Le rapport ne sort que par la route de détail : une liste de cent pages
      // qui les transporterait pèserait plusieurs mégaoctets pour n'en afficher
      // aucun.
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('"checks"');
      expect(res.body.scans.every((s: { report?: unknown }) => s.report === undefined)).toBe(true);
    });

    it('expose l’état du rapport de chaque page', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);
      const states = Object.fromEntries(
        res.body.scans.map((s: { id: string; reportState: string }) => [s.id, s.reportState]),
      );
      expect(states).toEqual({
        [PAGE_NEW]: 'compressed',
        [PAGE_OLD]: 'inline',
        [PAGE_PURGED]: 'purged',
      });
    });

    it('filtre par domaine', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans?domain=exemple'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.total).toBe(3);

      const none = await http
        .get(t.url('/scans?domain=inconnu'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(none.body.total).toBe(0);
    });

    it('filtre par intervalle de score', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans?scoreMin=3'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.total).toBe(2);
    });

    it('filtre par intervalle de dates', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans?dateFrom=2026-06-05&dateTo=2026-06-30'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.total).toBe(1);
    });

    it('pagine', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans?limit=2&page=2'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body).toMatchObject({ page: 2, limit: 2, pages: 2 });
      expect(res.body.scans).toHaveLength(1);
    });

    it('REFUSE un intervalle de score inversé au lieu de rendre une liste vide', async () => {
      // Une liste vide serait lue comme « aucun scan », pas comme « ta requête
      // n'a pas de sens ».
      const admin = await session(ADMIN);
      await http
        .get(t.url('/scans?scoreMin=5&scoreMax=1'))
        .set('Cookie', admin.cookies)
        .expect(400);
    });

    it('refuse un paramètre inconnu', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans?inconnu=1')).set('Cookie', admin.cookies).expect(400);
    });
  });

  // ── Vue par site ───────────────────────────────────────────────────────────

  describe('GET /scans/sites', () => {
    it('rend un site résumé par sa session la PLUS RÉCENTE', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans/sites')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.sites[0]).toMatchObject({
        domain: 'exemple.fr',
        gamme: 'premium',
        lastSessionId: SESSION_NEW,
        sessionCount: 2,
      });
    });
  });

  describe('GET /scans/sites/sessions', () => {
    it('rend l’historique du site, du plus récent au plus ancien', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans/sites/sessions?domain=exemple.fr&gamme=premium'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.map((s: { sessionId: string }) => s.sessionId)).toEqual([
        SESSION_NEW,
        SESSION_OLD,
      ]);
    });

    it('traite une gamme VIDE comme une gamme absente', async () => {
      // Un formulaire dont le champ n'est pas rempli envoie `gamme=` : les
      // distinguer ferait échouer la recherche d'un site sans gamme.
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/scans/sites/sessions?domain=exemple.fr&gamme='))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('exige le domaine', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans/sites/sessions')).set('Cookie', admin.cookies).expect(400);
    });
  });

  // ── Détail ─────────────────────────────────────────────────────────────────

  describe('GET /scans/:pageId', () => {
    it('sert un rapport stocké en clair', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/${PAGE_OLD}`))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.report.checks.METAS.status).toBe('pass');
    });

    it('DÉCOMPRESSE un rapport archivé', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/${PAGE_NEW}`))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.report.checks.METAS.status).toBe('fail');
    });

    it('répond 410 GONE — et non 404 — sur un rapport purgé', async () => {
      // La v1 répondait 404 « scan introuvable » : faux, puisque le scan
      // existe, et trompeur, puisque l'utilisateur part chercher une donnée que
      // l'application a elle-même supprimée.
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/${PAGE_PURGED}`))
        .set('Cookie', admin.cookies)
        .expect(410);

      expect(res.body.details.purgedAt).toBe('2026-06-05T03:00:00.000Z');
      expect(res.body.message).toContain('2026-06-05');
    });

    it('répond 404 sur une page inexistante', async () => {
      const admin = await session(ADMIN);
      await http
        .get(t.url(`/scans/${UNKNOWN}`))
        .set('Cookie', admin.cookies)
        .expect(404);
    });

    it('refuse un identifiant qui n’est pas un UUID', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans/pas-un-uuid')).set('Cookie', admin.cookies).expect(400);
    });
  });

  describe('GET /scans/sessions/:id', () => {
    it('rend les pages de la session, rapports compris', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.pages).toHaveLength(2);
      expect(res.body.truncated).toBe(false);
    });

    it('marque la page purgée sans faire échouer la session', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      const purged = res.body.pages.find((p: { id: string }) => p.id === PAGE_PURGED);
      expect(purged).toMatchObject({ reportState: 'purged', report: null });
    });
  });

  // ── Comparaison ────────────────────────────────────────────────────────────

  describe('GET /scans/sessions/:a/compare/:b', () => {
    it('compare deux audits du même site', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}/compare/${SESSION_NEW}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.base.sessionId).toBe(SESSION_OLD);
      expect(res.body.target.sessionId).toBe(SESSION_NEW);
      expect(res.body.scoreDelta).toBe(-2);
      expect(res.body.summary).toMatchObject({ degraded: 1, removed: 1 });
    });

    it('rend le MÊME résultat quel que soit l’ordre des identifiants', async () => {
      const admin = await session(ADMIN);
      const direct = await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}/compare/${SESSION_NEW}`))
        .set('Cookie', admin.cookies)
        .expect(200);
      const inverse = await http
        .get(t.url(`/scans/sessions/${SESSION_NEW}/compare/${SESSION_OLD}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(inverse.body).toEqual(direct.body);
    });

    it('détaille les critères qui ont reculé', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}/compare/${SESSION_NEW}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      const page = res.body.pages.find((p: { url: string }) => p.url === 'https://exemple.fr/');
      expect(page.checks).toEqual([
        { checkId: 'METAS', baseStatus: 'pass', targetStatus: 'fail', trend: 'degraded' },
      ]);
    });

    it('refuse la comparaison de deux sites différents', async () => {
      t.db.scanSites.set('site-2', {
        id: 'site-2',
        domain: 'autre.fr',
        gamme: null,
        epj: null,
        metadata: null,
        last_seen: '2026-06-01 10:00:00',
      });
      t.db.scanSessions.set(UNKNOWN, {
        id: UNKNOWN,
        site_id: 'site-2',
        gamme: null,
        epj: null,
        platform: null,
        page_count: 0,
        avg_score: null,
        min_score: null,
        max_score: null,
        analyzed_at: '2026-06-01 10:00:00',
        duration_ms: null,
        launched_by: null,
        profile_snapshot: null,
      });

      const admin = await session(ADMIN);
      await http
        .get(t.url(`/scans/sessions/${SESSION_OLD}/compare/${UNKNOWN}`))
        .set('Cookie', admin.cookies)
        .expect(400);
    });
  });

  // ── Scans personnels ───────────────────────────────────────────────────────

  describe('GET /scans/mine/:id', () => {
    it('OUVRE au testeur la session qu’il a lancée', async () => {
      // Sans cette route, un testeur ne pourrait pas revoir son propre audit de
      // la veille : il ne détient pas `history:read`.
      const tester = await session(TESTER);
      const res = await http
        .get(t.url(`/scans/mine/${SESSION_OLD}`))
        .set('Cookie', tester.cookies)
        .expect(200);
      expect(res.body.sessionId).toBe(SESSION_OLD);
    });

    it('répond 404 — et non 403 — sur la session d’autrui', async () => {
      // Un 403 confirmerait l'existence de la session et permettrait d'énumérer
      // les audits des autres comptes.
      const tester = await session(TESTER);
      await http
        .get(t.url(`/scans/mine/${SESSION_NEW}`))
        .set('Cookie', tester.cookies)
        .expect(404);
    });

    it('laisse un administrateur relire n’importe quelle session', async () => {
      const admin = await session(ADMIN);
      await http
        .get(t.url(`/scans/mine/${SESSION_OLD}`))
        .set('Cookie', admin.cookies)
        .expect(200);
    });
  });

  // ── Statistiques ───────────────────────────────────────────────────────────

  describe('GET /scans/stats', () => {
    it('agrège les trois étages de stockage', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans/stats')).set('Cookie', admin.cookies).expect(200);

      expect(res.body).toMatchObject({
        total: 3,
        sites: 1,
        sessions: 2,
        inline: 1,
        compressed: 1,
        purged: 1,
      });
    });
  });

  // ── Suppression ────────────────────────────────────────────────────────────

  describe('DELETE /scans', () => {
    it('supprime des pages et RÉCONCILIE la session', async () => {
      const admin = await session(ADMIN);
      const res = await write('delete', '/scans', admin)
        .send({ ids: [PAGE_PURGED] })
        .expect(200);

      expect(res.body).toEqual({ deleted: 1 });
      expect(t.db.scanSessions.get(SESSION_OLD)?.page_count).toBe(1);
    });

    it('SUPPRIME la session devenue vide, et le site avec elle', async () => {
      const admin = await session(ADMIN);
      await write('delete', '/scans', admin)
        .send({ ids: [PAGE_OLD, PAGE_PURGED, PAGE_NEW] })
        .expect(200);

      expect(t.db.scanSessions.size).toBe(0);
      expect(t.db.scanSites.size).toBe(0);
    });

    it('journalise la suppression', async () => {
      const admin = await session(ADMIN);
      await write('delete', '/scans', admin)
        .send({ ids: [PAGE_OLD] })
        .expect(200);

      const entry = t.db.auditLog.find(e => e.action === 'scans.delete_pages');
      expect(entry).toMatchObject({ actorName: 'admin' });
    });
  });

  describe('DELETE /scans/sites', () => {
    it('efface le site et toutes ses sessions', async () => {
      const admin = await session(ADMIN);
      const res = await write('delete', '/scans/sites', admin)
        .send({ domain: 'exemple.fr', gamme: 'premium' })
        .expect(200);

      expect(res.body).toEqual({ deleted: 3 });
      expect(t.db.scanPages.size).toBe(0);
    });

    it('EXIGE la gamme, fût-elle nulle', async () => {
      // L'omettre laisserait croire « toutes gammes » et effacerait davantage
      // que demandé.
      const admin = await session(ADMIN);
      await write('delete', '/scans/sites', admin).send({ domain: 'exemple.fr' }).expect(400);
    });

    it('n’efface PAS un autre site du même domaine quand la gamme diffère', async () => {
      const admin = await session(ADMIN);
      await write('delete', '/scans/sites', admin)
        .send({ domain: 'exemple.fr', gamme: 'start' })
        .expect(200);

      expect(t.db.scanSites.size).toBe(1);
    });
  });

  describe('DELETE /scans/sessions/:id', () => {
    it('efface la session et ses pages', async () => {
      const admin = await session(ADMIN);
      const res = await write('delete', `/scans/sessions/${SESSION_OLD}`, admin).expect(200);

      expect(res.body).toEqual({ deleted: 2 });
      expect(t.db.scanSessions.has(SESSION_OLD)).toBe(false);
      expect(t.db.scanSites.size).toBe(1);
    });

    it('répond 404 sur une session inconnue', async () => {
      const admin = await session(ADMIN);
      await write('delete', `/scans/sessions/${UNKNOWN}`, admin).expect(404);
    });
  });

  describe('DELETE /scans/domains/:domain', () => {
    it('efface toutes les gammes du domaine', async () => {
      const admin = await session(ADMIN);
      const res = await write('delete', '/scans/domains/exemple.fr', admin).expect(200);

      expect(res.body).toEqual({ deleted: 3 });
      expect(t.db.scanSites.size).toBe(0);
    });
  });
});
