import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 3 (historique des scans).
 *
 * Complète les deux suites précédentes sur la surface propre à ce module : une
 * recherche à nombreux filtres qui alimente une requête SQL, un tri qui atteint
 * la STRUCTURE de cette requête, un contrôle d'accès à deux niveaux
 * (permission globale contre appartenance personnelle), et des suppressions
 * irréversibles en masse.
 */

const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const EDITOR = {
  id: 'u-edit',
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
const SESSION_TESTER = '11111111-1111-4111-8111-111111111111';
const SESSION_ADMIN = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe('Suite sécurité OWASP — module 3 (E2E)', () => {
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

  function seed(): void {
    t.db.scanSites.set(SITE, {
      id: SITE,
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: 'ABC-123',
      metadata: null,
      last_seen: '2026-06-10 10:00:00',
    });
    for (const [id, launchedBy] of [
      [SESSION_TESTER, 'testeur'],
      [SESSION_ADMIN, 'admin'],
    ] as const) {
      t.db.scanSessions.set(id, {
        id,
        site_id: SITE,
        gamme: 'premium',
        epj: 'ABC-123',
        platform: 'duda',
        page_count: 1,
        avg_score: 4,
        min_score: 4,
        max_score: 4,
        analyzed_at: '2026-06-01 10:00:00',
        duration_ms: 1000,
        launched_by: launchedBy,
        profile_snapshot: null,
      });
    }
    t.db.scanPages.set(PAGE, {
      id: PAGE,
      session_id: SESSION_ADMIN,
      url: 'https://exemple.fr/',
      domain: 'exemple.fr',
      global_score: 4,
      status_code: 200,
      analyzed_at: '2026-06-01 10:00:00',
      duration_ms: 1000,
      check_summary: { METAS: 'pass' },
      report: '{"checks":{}}',
      report_gz: null,
      is_compressed: 0,
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

  function del(path: string, auth: { cookies: string[]; csrf: string }) {
    return http.delete(t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  // ── 1 ──────────────────────────────────────────────────────────────────────

  describe('1. Injection SQL', () => {
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE scan_pages; --",
      "1' UNION SELECT password_hash FROM users --",
      "exemple.fr'); DELETE FROM sites WHERE ('1'='1",
    ];

    it.each(payloads)('neutralise %s dans le filtre de domaine', async payload => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans?domain=${encodeURIComponent(payload)}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      // La charge est traitée comme du TEXTE : elle ne trouve rien et
      // n'exécute rien. Les données sont toujours là.
      expect(res.body.total).toBe(0);
      expect(t.db.scanPages.size).toBe(1);
      expect(t.db.users.size).toBe(3);
    });

    it.each(payloads)('neutralise %s dans la recherche libre', async payload => {
      const admin = await session(ADMIN);
      await http
        .get(t.url(`/scans?q=${encodeURIComponent(payload)}`))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(t.db.scanPages.size).toBe(1);
    });

    it('REFUSE un tri hors de la liste fermée', async () => {
      // Le tri est la seule valeur qui atteindrait la STRUCTURE de la requête
      // et non ses paramètres : c'est le seul point du module où une injection
      // resterait concevable.
      const admin = await session(ADMIN);
      await http
        .get(t.url('/scans?sort=' + encodeURIComponent('analyzed_at); DROP TABLE users; --')))
        .set('Cookie', admin.cookies)
        .expect(400);
    });

    it('refuse un sens de tri inventé', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans?order=RANDOM()')).set('Cookie', admin.cookies).expect(400);
    });

    it('n’exécute pas un opérateur booléen glissé dans la recherche plein texte', async () => {
      // En mode booléen, MariaDB interprète `+ - ( ) ~ *` : une parenthèse non
      // fermée provoquait une erreur de syntaxe servie en 500 par la v1.
      const admin = await session(ADMIN);
      await http
        .get(t.url(`/scans?q=${encodeURIComponent('exemple((( +++ ~~~')}`))
        .set('Cookie', admin.cookies)
        .expect(200);
    });
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    const readRoutes = [
      '/scans',
      '/scans/sites',
      '/scans/stats',
      `/scans/sessions/${SESSION_ADMIN}`,
      `/scans/${PAGE}`,
    ];

    it.each(readRoutes)('refuse %s à un testeur', async route => {
      // Le rang testeur ne détient pas `history:read` : il ne voit que ses
      // propres scans.
      const tester = await session(TESTER);
      await http.get(t.url(route)).set('Cookie', tester.cookies).expect(403);
    });

    it.each(readRoutes)('refuse %s sans authentification', async route => {
      await http.get(t.url(route)).expect(401);
    });

    it('OUVRE la lecture à un éditeur — il détient history:read', async () => {
      const editor = await session(EDITOR);
      await http.get(t.url('/scans')).set('Cookie', editor.cookies).expect(200);
    });

    it('REFUSE la suppression à un éditeur — il ne détient pas history:delete', async () => {
      const editor = await session(EDITOR);
      await del('/scans', editor)
        .send({ ids: [PAGE] })
        .expect(403);
      expect(t.db.scanPages.size).toBe(1);
    });

    it.each([
      '/scans',
      `/scans/sessions/${SESSION_ADMIN}`,
      '/scans/sites',
      '/scans/domains/exemple.fr',
    ])('refuse la suppression %s à un testeur', async route => {
      const tester = await session(TESTER);
      await del(route, tester)
        .send({ ids: [PAGE], domain: 'exemple.fr', gamme: null })
        .expect(403);
      expect(t.db.scanPages.size).toBe(1);
    });

    it('CLOISONNE les scans personnels par compte', async () => {
      const tester = await session(TESTER);
      await http
        .get(t.url(`/scans/mine/${SESSION_TESTER}`))
        .set('Cookie', tester.cookies)
        .expect(200);
      await http
        .get(t.url(`/scans/mine/${SESSION_ADMIN}`))
        .set('Cookie', tester.cookies)
        .expect(404);
    });

    it('rend la MÊME réponse pour une session d’autrui et une session inexistante', async () => {
      // Deux réponses différentes feraient de la route un oracle d'existence :
      // on énumérerait les audits des autres comptes en distinguant 403 et 404.
      const tester = await session(TESTER);
      const other = await http
        .get(t.url(`/scans/mine/${SESSION_ADMIN}`))
        .set('Cookie', tester.cookies);
      const missing = await http.get(t.url(`/scans/mine/${UNKNOWN}`)).set('Cookie', tester.cookies);

      expect(other.status).toBe(missing.status);
      expect(other.body.message).toBe(missing.body.message);
    });

    it('refuse un jeton d’un autre porteur', async () => {
      await http.get(t.url('/scans')).set('Authorization', 'Bearer pas-un-jeton').expect(401);
    });
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────

  describe('3. CSRF', () => {
    it.each([
      ['/scans', 'ids'],
      ['/scans/sites', 'site'],
      ['/scans/domains/exemple.fr', 'domaine'],
    ] as const)('refuse la suppression par %s sans jeton CSRF', async (route, _kind) => {
      const admin = await session(ADMIN);
      await http
        .delete(t.url(route))
        .set('Cookie', admin.cookies)
        .send({ ids: [PAGE], domain: 'exemple.fr', gamme: null })
        .expect(403);
      expect(t.db.scanPages.size).toBe(1);
    });

    it('refuse un jeton CSRF qui ne correspond pas au cookie', async () => {
      const admin = await session(ADMIN);
      await http
        .delete(t.url('/scans'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', 'jeton-fabrique')
        .send({ ids: [PAGE] })
        .expect(403);
    });

    it('n’exige PAS de jeton CSRF d’un client Bearer', async () => {
      // Un client programmatique ne transporte pas de cookie : il n'est pas
      // exposé à la falsification de requête inter-site.
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      const token = cookieValue(res.headers['set-cookie'] as unknown as string[], COOKIES.ACCESS)!;

      await http
        .delete(t.url('/scans'))
        .set('Authorization', `Bearer ${token}`)
        .send({ ids: [PAGE] })
        .expect(200);
    });
  });

  // ── 15 ─────────────────────────────────────────────────────────────────────

  describe('15. Mass assignment et validation d’entrée', () => {
    it('refuse un filtre inconnu au lieu de l’ignorer', async () => {
      const admin = await session(ADMIN);
      await http
        .get(t.url('/scans?limit=20&siteId=' + SITE))
        .set('Cookie', admin.cookies)
        .expect(400);
    });

    it('plafonne la taille de page', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans?limit=100000')).set('Cookie', admin.cookies).expect(400);
    });

    it('BORNE la suppression en masse', async () => {
      // Une requête sans borne effacerait l'historique entier en un appel.
      const admin = await session(ADMIN);
      const ids = Array.from({ length: 201 }, () => PAGE);
      await del('/scans', admin).send({ ids }).expect(400);
      expect(t.db.scanPages.size).toBe(1);
    });

    it('refuse une suppression sans cible', async () => {
      const admin = await session(ADMIN);
      await del('/scans', admin).send({ ids: [] }).expect(400);
    });

    it('refuse un identifiant qui n’est pas un UUID', async () => {
      const admin = await session(ADMIN);
      await del('/scans', admin)
        .send({ ids: ["1' OR '1'='1"] })
        .expect(400);
      expect(t.db.scanPages.size).toBe(1);
    });

    it('refuse un champ surnuméraire dans une suppression de site', async () => {
      const admin = await session(ADMIN);
      await del('/scans/sites', admin)
        .send({ domain: 'exemple.fr', gamme: null, cascade: true })
        .expect(400);
    });
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────

  describe('9. Pollution de prototype', () => {
    it('ne pollue pas Object.prototype par un corps de suppression', async () => {
      const admin = await session(ADMIN);
      await del('/scans', admin)
        .set('Content-Type', 'application/json')
        .send('{"ids":["' + PAGE + '"],"__proto__":{"pollue":true}}');

      expect(({} as Record<string, unknown>).pollue).toBeUndefined();
    });

    it('ne pollue pas Object.prototype par une chaîne de requête', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/scans?__proto__[pollue]=true')).set('Cookie', admin.cookies);

      expect(({} as Record<string, unknown>).pollue).toBeUndefined();
    });

    it('n’interprète pas un résumé de critères corrompu en base', async () => {
      // `check_summary` vient de la base : une version antérieure, ou une
      // écriture directe, peut y avoir laissé n'importe quoi.
      t.db.scanPages.get(PAGE)!.check_summary = JSON.parse('{"__proto__":{"pollue":true}}');

      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.scans[0].checkSummary).toEqual({});
      expect(({} as Record<string, unknown>).pollue).toBeUndefined();
    });
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────

  describe('7. Données sensibles et messages d’erreur', () => {
    it('ne divulgue AUCUNE trace d’exécution sur une panne interne', async () => {
      const admin = await session(ADMIN);
      t.db.scanPages.get(PAGE)!.check_summary = undefined;
      const res = await http.get(t.url(`/scans/${UNKNOWN}`)).set('Cookie', admin.cookies);

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at .*\.ts:\d+/);
      expect(body).not.toContain('node_modules');
      expect(body).not.toContain('SELECT');
    });

    it('ne renvoie pas l’identifiant demandé en écho dans un 404', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url(`/scans/${UNKNOWN}`)).set('Cookie', admin.cookies);
      expect(JSON.stringify(res.body)).not.toContain(UNKNOWN);
    });

    it('n’expose aucun nom de colonne ni de table dans une erreur de validation', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans?scoreMin=99')).set('Cookie', admin.cookies);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('scan_pages');
      expect(body).not.toContain('global_score');
    });

    it('n’expose pas le rapport d’une page purgée', async () => {
      t.db.scanPages.get(PAGE)!.report = null;
      t.db.scanPages.get(PAGE)!.report_purged_at = '2026-06-05 03:00:00';

      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/scans/${PAGE}`))
        .set('Cookie', admin.cookies)
        .expect(410);
      expect(JSON.stringify(res.body)).not.toContain('checks');
    });
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────

  describe('2. XSS', () => {
    it('sert du JSON, jamais du HTML interprétable', async () => {
      t.db.scanPages.get(PAGE)!.url = 'https://exemple.fr/<script>alert(1)</script>';

      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // La charge est RESTITUÉE telle quelle — c'est le rôle du client de
      // l'échapper à l'affichage — mais jamais servie comme du HTML.
      expect(res.body.scans[0].url).toContain('<script>');
    });
  });

  // ── 12 ─────────────────────────────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('resserre la limite sur la suppression de domaine', async () => {
      // L'action la plus destructrice du module : elle efface plusieurs sites
      // d'un coup. La limite borne les dégâts d'un jeton volé.
      const admin = await session(ADMIN);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await del('/scans/domains/inconnu.fr', admin);
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });

    it('laisse passer un usage normal de la recherche', async () => {
      const admin = await session(ADMIN);
      for (let i = 0; i < 10; i += 1) {
        await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);
      }
    });
  });

  // ── 11 ─────────────────────────────────────────────────────────────────────

  describe('11. Journalisation', () => {
    type Auth = { cookies: string[]; csrf: string };

    it.each([
      ['scans.delete_pages', (a: Auth) => del('/scans', a).send({ ids: [PAGE] })],
      [
        'scans.delete_site',
        (a: Auth) => del('/scans/sites', a).send({ domain: 'exemple.fr', gamme: 'premium' }),
      ],
      ['scans.delete_domain', (a: Auth) => del('/scans/domains/exemple.fr', a)],
      ['scans.delete_session', (a: Auth) => del(`/scans/sessions/${SESSION_ADMIN}`, a)],
    ] as const)('trace %s', async (action, call) => {
      // Une suppression irréversible qui ne laisse pas de trace est un angle
      // mort : impossible de savoir, après coup, qui a effacé quoi.
      const admin = await session(ADMIN);
      await call(admin);
      expect(t.db.auditLog.some(e => e.action === action)).toBe(true);
    });

    it('trace un refus de permission', async () => {
      const tester = await session(TESTER);
      await http.get(t.url('/scans')).set('Cookie', tester.cookies).expect(403);

      expect(
        t.db.auditLog.some(
          e =>
            e.action === 'auth.permission_denied' &&
            (e.details as { permission?: string }).permission === 'history:read',
        ),
      ).toBe(true);
    });
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────

  describe('6. Mauvaise configuration', () => {
    it('porte les en-têtes de sécurité sur les réponses de l’historique', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/scans')).set('Cookie', admin.cookies).expect(200);

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('n’expose AUCUNE route d’écriture de l’historique', async () => {
      // L'historique s'alimente en process. Un endpoint d'ingestion offrirait à
      // un jeton volé le moyen de fabriquer un passé dans une base dont l'objet
      // même est de faire foi.
      const admin = await session(ADMIN);
      const body = { sessionId: SESSION_ADMIN, domain: 'faux.fr', pages: [] };

      for (const route of ['/scans', '/scans/ingest', '/scans/sessions']) {
        const res = await http
          .post(t.url(route))
          .set('Cookie', admin.cookies)
          .set('X-CSRF-Token', admin.csrf)
          .send(body);
        expect([404, 405]).toContain(res.status);
      }
      expect(t.db.scanSites.size).toBe(1);
    });
  });
});
