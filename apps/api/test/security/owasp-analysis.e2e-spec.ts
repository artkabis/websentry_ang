import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 4 (moteur d'analyse).
 *
 * C'est le SEUL module qui émette des requêtes vers l'extérieur : chaque route
 * déclenche une connexion sortante vers une URL fournie par l'appelant. La
 * surface propre à ce module est donc le SSRF, la validation d'URL, et
 * l'isolation des réglages transmis par le client.
 */

const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const TESTER = {
  id: 'u-test',
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

const PAGE_HTML = `<html lang="fr"><head>
  <title>Boulangerie artisanale à Lyon — pains au levain</title>
  <meta name="description" content="Notre boulangerie artisanale lyonnaise propose des pains au levain naturel, viennoiseries et pâtisseries préparés chaque matin sur place.">
  <link rel="canonical" href="https://exemple.fr/">
</head><body><h1>Boulangerie</h1><h2>A</h2><h2>B</h2><p>${'contenu '.repeat(300)}</p></body></html>`;

describe('Suite sécurité OWASP — module 4 (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, TESTER]);
    http = request(t.app.getHttpServer());
    t.db.pages.set('https://exemple.fr/', PAGE_HTML);
  });

  afterEach(async () => {
    await t.close();
  });

  async function session(user: { username: string; password: string }) {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: user.username, password: user.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, csrf: cookieValue(cookies, COOKIES.CSRF)! };
  }

  function post(path: string, auth: { cookies: string[]; csrf: string }) {
    return http.post(t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  // ── 8 ──────────────────────────────────────────────────────────────────────

  describe('8. SSRF', () => {
    const forbidden = [
      ['file:///etc/passwd', 'lecture du disque'],
      ['gopher://exemple.fr/', 'protocole détourné'],
      ['data:text/html,<script>alert(1)</script>', 'charge embarquée'],
      ['javascript:alert(1)', 'exécution côté client'],
      ['ftp://exemple.fr/fichier', 'protocole non maîtrisé'],
    ] as const;

    it.each(forbidden)('REFUSE %s (%s) dès la validation', async (url, _why) => {
      // Ces URL sont valides au sens de la norme : seul le protocole les
      // distingue. Les refuser au schéma évite d'engager la moindre résolution.
      const admin = await session(ADMIN);
      await post('/analyze', admin).send({ url }).expect(400);
    });

    it.each(forbidden)('refuse %s (%s) aussi dans un LOT', async (url, _why) => {
      // Un lot n'est pas un moyen de faire passer ce qu'une requête unitaire
      // refuserait.
      const admin = await session(ADMIN);
      await post('/analyze/batch', admin)
        .send({ urls: ['https://exemple.fr/', url] })
        .expect(400);
    });

    it('refuse un protocole interdit sur le flux SSE', async () => {
      const admin = await session(ADMIN);
      await post('/analyze/stream', admin).send({ url: 'file:///etc/passwd' }).expect(400);
    });

    it('refuse un protocole interdit à la lecture de sitemap', async () => {
      const admin = await session(ADMIN);
      await post('/sitemap/parse', admin).send({ url: 'file:///etc/hosts' }).expect(400);
    });

    it('refuse une URL non absolue', async () => {
      const admin = await session(ADMIN);
      await post('/analyze', admin).send({ url: '/etc/passwd' }).expect(400);
    });
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it.each(['/analyze', '/analyze/stream'])('refuse %s sans authentification', async route => {
      await http.post(t.url(route)).send({ url: 'https://exemple.fr/' }).expect(401);
    });

    it('OUVRE l’analyse unitaire au rang testeur', async () => {
      // `scan:run` fait partie de ses droits par défaut : c'est la raison d'être
      // de ce rang.
      const tester = await session(TESTER);
      await post('/analyze', tester).send({ url: 'https://exemple.fr/' }).expect(200);
    });

    it('REFUSE le lot au rang testeur — il ne détient pas scan:batch', async () => {
      const tester = await session(TESTER);
      await post('/analyze/batch', tester)
        .send({ urls: ['https://exemple.fr/'] })
        .expect(403);
    });

    it('refuse la lecture de sitemap au rang testeur', async () => {
      const tester = await session(TESTER);
      await post('/sitemap/parse', tester).send({ url: 'https://exemple.fr/s.xml' }).expect(403);
    });

    it('IGNORE un profil imposé sans permission, sans refuser l’analyse', async () => {
      // Un utilisateur sans `profiles:use` obtient son analyse, avec le profil
      // auquel il a droit : le refus serait une punition sans objet.
      const tester = await session(TESTER);
      await post('/analyze', tester)
        .send({ url: 'https://exemple.fr/', profileOverride: 'premium' })
        .expect(200);
    });
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────

  describe('3. CSRF', () => {
    it.each(['/analyze', '/analyze/batch', '/analyze/stream', '/sitemap/parse'])(
      'refuse %s sans jeton CSRF',
      async route => {
        const admin = await session(ADMIN);
        await http
          .post(t.url(route))
          .set('Cookie', admin.cookies)
          .send({ url: 'https://exemple.fr/', urls: ['https://exemple.fr/'] })
          .expect(403);
      },
    );
  });

  // ── 15 ─────────────────────────────────────────────────────────────────────

  describe('15. Mass assignment et validation d’entrée', () => {
    it('refuse un champ surnuméraire', async () => {
      const admin = await session(ADMIN);
      await post('/analyze', admin)
        .send({ url: 'https://exemple.fr/', renderMode: 'browser' })
        .expect(400);
    });

    it('BORNE la taille d’un lot', async () => {
      // Sans borne, un appel unique déclencherait des milliers de connexions
      // sortantes.
      const admin = await session(ADMIN);
      const urls = Array.from({ length: 201 }, (_, i) => `https://exemple.fr/${i}`);
      await post('/analyze/batch', admin).send({ urls }).expect(400);
    });

    it('refuse un lot vide', async () => {
      const admin = await session(ADMIN);
      await post('/analyze/batch', admin).send({ urls: [] }).expect(400);
    });

    it('refuse des réglages hors bornes', async () => {
      const admin = await session(ADMIN);
      await post('/analyze', admin)
        .send({ url: 'https://exemple.fr/', settings: { meta: { title: { min: -5, max: 9999 } } } })
        .expect(400);
    });

    it('plafonne la limite de lecture d’un sitemap', async () => {
      const admin = await session(ADMIN);
      await post('/sitemap/parse', admin)
        .send({ url: 'https://exemple.fr/s.xml', limit: 100_000 })
        .expect(400);
    });
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────

  describe('9. Pollution de prototype', () => {
    it('ne pollue pas Object.prototype par des réglages', async () => {
      const admin = await session(ADMIN);
      await post('/analyze', admin)
        .set('Content-Type', 'application/json')
        .send('{"url":"https://exemple.fr/","settings":{"__proto__":{"pollue":true}}}');

      expect(({} as Record<string, unknown>).pollue).toBeUndefined();
    });
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────

  describe('7. Données sensibles et messages d’erreur', () => {
    it('NE DIVULGUE PAS le détail réseau d’un hôte injoignable', async () => {
      // Un message d'undici cite l'hôte, le port et le code système : autant
      // d'informations sur le réseau interne.
      const admin = await session(ADMIN);
      const res = await post('/analyze', admin).send({ url: 'https://inconnu.test/' });

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at .*\.ts:\d+/);
      expect(body).not.toContain('node_modules');
    });

    it('FILTRE les en-têtes HTTP du rapport par liste fermée', async () => {
      // Un rapport est stocké puis relu par des tiers : y recopier tous les
      // en-têtes ferait entrer cookies et jetons.
      const admin = await session(ADMIN);
      const res = await post('/analyze', admin).send({ url: 'https://exemple.fr/' }).expect(200);

      expect(Object.keys(res.body.httpHeaders)).toEqual(['content-type']);
    });

    it('n’expose PAS le HTML brut de la page analysée', async () => {
      const admin = await session(ADMIN);
      const res = await post('/analyze', admin).send({ url: 'https://exemple.fr/' }).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('<body>');
    });
  });

  // ── 12 ─────────────────────────────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('RESSERRE la limite sur le lot', async () => {
      // Un lot vaut jusqu'à deux cents pages, donc autant de requêtes sortantes
      // par appel : c'est la route la plus coûteuse de l'application.
      const admin = await session(ADMIN);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await post('/analyze/batch', admin).send({ urls: ['https://exemple.fr/'] });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────

  describe('6. Mauvaise configuration', () => {
    it('porte les en-têtes de sécurité sur les réponses d’analyse', async () => {
      const admin = await session(ADMIN);
      const res = await post('/analyze', admin).send({ url: 'https://exemple.fr/' }).expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('sert le catalogue des critères à tout compte pouvant lancer un scan', async () => {
      const tester = await session(TESTER);
      const res = await http
        .get(t.url('/analyze/checks'))
        .set('Cookie', tester.cookies)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
