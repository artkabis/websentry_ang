import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 10 (portail documentation).
 *
 * Deux risques, et un seul est réel. Le premier serait la TRAVERSÉE DE CHEMIN :
 * un portail qui sert des fichiers finit toujours par se faire demander
 * `../../etc/passwd`. Ici la question ne se pose pas — les pages sont lues une
 * fois au démarrage et servies depuis une table en mémoire, donc aucune
 * requête n'atteint le système de fichiers. Les tests le vérifient quand même :
 * c'est précisément le genre de garantie qu'une refonte fait sauter sans le
 * dire.
 *
 * Le second serait le XSS STOCKÉ, si le contenu devenait du HTML. L'API rend
 * une structure typée ; les tests exigent qu'aucun balisage ne circule.
 */

const ID_ADMIN = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';

const ADMIN = {
  id: ID_ADMIN,
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const BOB = { id: ID_BOB, username: 'bob', password: 'MotDePasseBob!2026', rank: RANKS.TESTER };

describe('Suite sécurité OWASP — module 10 (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, BOB]);
    http = request(t.app.getHttpServer());
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

  function lire(chemin: string, auth: { cookies: string[] }) {
    return http.get(t.url(chemin)).set('Cookie', auth.cookies);
  }

  // ── 14. Traversée de chemin ───────────────────────────────────────────────

  describe('14. Traversée de chemin', () => {
    it.each([
      '../package',
      '../../package.json',
      '..%2F..%2Fpackage.json',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//etc/passwd',
      'premiers-pas.md',
      'nul%00.md',
      '/etc/passwd',
    ])('REFUSE « %s » comme identifiant de page', async slug => {
      const admin = await session(ADMIN);
      const res = await lire(`/docs/${slug}`, admin);

      expect([400, 404]).toContain(res.status);
      const corps = JSON.stringify(res.body);
      expect(corps).not.toContain('root:');
      expect(corps).not.toContain('"dependencies"');
      expect(corps).not.toContain('titre:');
    });

    it('ne sert AUCUN fichier par un chemin absolu encodé', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/%2Fetc%2Fpasswd', admin);

      expect([400, 404]).toContain(res.status);
    });

    it('n’expose AUCUN chemin du serveur, même dans une erreur', async () => {
      // Un chemin dans un message d'erreur dessine l'arborescence de l'hôte.
      const admin = await session(ADMIN);
      const res = await lire('/docs/inexistante', admin).expect(404);
      const corps = JSON.stringify(res.body);

      expect(corps).not.toContain('/src/');
      expect(corps).not.toContain('/dist/');
      expect(corps).not.toContain('.md');
      expect(corps).not.toContain('node_modules');
    });
  });

  // ── 2. XSS stocké ─────────────────────────────────────────────────────────

  describe('2. XSS stocké', () => {
    it('ne transporte AUCUN balisage — la page est une STRUCTURE', async () => {
      // Rendre du HTML obligerait à le désinfecter, donc à tenir à jour une
      // liste de balises admises. Une structure fermée n'a rien à désinfecter.
      const admin = await session(ADMIN);
      const res = await lire('/docs/premiers-pas', admin).expect(200);
      const corps = JSON.stringify(res.body);

      expect(res.body).not.toHaveProperty('html');
      expect(corps).not.toMatch(/<[a-z]+[\s>]/i);
      expect(corps).not.toContain('<script');
    });

    it('n’admet QUE des types de blocs connus', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/premiers-pas', admin).expect(200);

      const types = new Set((res.body.blocs as { type: string }[]).map(b => b.type));
      for (const type of types) {
        expect(['titre', 'paragraphe', 'liste', 'code', 'note']).toContain(type);
      }
    });

    it('n’admet QUE des adresses de lien inoffensives', async () => {
      // `javascript:` n'a même pas de représentation possible dans le schéma.
      const admin = await session(ADMIN);
      const sommaire = await lire('/docs', admin).expect(200);

      for (const section of sommaire.body.sections as { pages: { slug: string }[] }[]) {
        for (const { slug } of section.pages) {
          const page = await lire(`/docs/${slug}`, admin).expect(200);
          const corps = JSON.stringify(page.body);

          expect(corps).not.toContain('javascript:');
          expect(corps).not.toContain('data:');
          for (const href of [...corps.matchAll(/"href":"([^"]*)"/g)].map(m => m[1] ?? '')) {
            expect(href).toMatch(/^(doc:[a-z0-9-]+|https:\/\/)/);
          }
        }
      }
    });

    it('sert du JSON NON interprétable, avec `nosniff`', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/premiers-pas', admin).expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rend un EXTRAIT de recherche en texte brut', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/recherche?q=score', admin).expect(200);

      for (const hit of res.body.resultats as { extrait: string }[]) {
        expect(hit.extrait).not.toContain('<');
        expect(hit.extrait).not.toContain('&lt;');
      }
    });
  });

  // ── 1. Injection ──────────────────────────────────────────────────────────

  describe('1. Injection', () => {
    it.each([
      "' OR '1'='1",
      '; DROP TABLE users; --',
      '${process.env}',
      '{{constructor.constructor("alert(1)")()}}',
      '../../../',
    ])('traite « %s » comme du TEXTE à chercher', async charge => {
      // La recherche est une comparaison de chaînes en mémoire : il n'y a ni
      // requête à injecter, ni gabarit à évaluer.
      const admin = await session(ADMIN);
      const res = await lire(`/docs/recherche?q=${encodeURIComponent(charge)}`, admin);

      expect(res.status).toBe(200);
      expect(res.body.q).toBe(charge);
      expect(JSON.stringify(res.body)).not.toContain('function');
    });
  });

  // ── 5. Contrôle d'accès ───────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it('FERME par défaut : aucune route n’est publique', async () => {
      await http.get(t.url('/docs')).expect(401);
      await http.get(t.url('/docs/recherche?q=scan')).expect(401);
      await http.get(t.url('/docs/premiers-pas')).expect(401);
    });

    it('REFUSE les trois lectures sans docs:read', async () => {
      const bob = await session(BOB);

      await lire('/docs', bob).expect(403);
      await lire('/docs/recherche?q=scan', bob).expect(403);
      await lire('/docs/premiers-pas', bob).expect(403);
    });

    it('n’expose AUCUNE écriture', async () => {
      // Les pages vivent dans le dépôt : une route d'écriture ferait du
      // portail une seconde source de vérité, désynchronisée du code.
      const admin = await session(ADMIN);

      for (const chemin of ['/docs', '/docs/premiers-pas', '/docs/recharger']) {
        for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
          await http[methode](t.url(chemin))
            .set('Cookie', admin.cookies)
            .set('X-CSRF-Token', admin.csrf)
            .expect(404);
        }
      }
    });

    it('ouvre à un rang INFÉRIEUR qui porte docs:read', async () => {
      t.db.permissions.set(ID_BOB, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]);
      const bob = await session(BOB);

      await lire('/docs', bob).expect(200);
    });
  });

  // ── 15. Validation d'entrée ───────────────────────────────────────────────

  describe('15. Validation d’entrée', () => {
    it('BORNE la recherche par le bas ET par le haut', async () => {
      const admin = await session(ADMIN);

      await lire('/docs/recherche?q=a', admin).expect(400);
      await lire(`/docs/recherche?q=${'a'.repeat(101)}`, admin).expect(400);
      await lire('/docs/recherche?q=scan&limit=51', admin).expect(400);
      await lire('/docs/recherche?q=scan&limit=0', admin).expect(400);
    });

    it('REFUSE un paramètre inconnu', async () => {
      const admin = await session(ADMIN);
      await lire('/docs/recherche?q=scan&fichier=../package.json', admin).expect(400);
    });

    it('REFUSE une requête SANS terme', async () => {
      const admin = await session(ADMIN);
      await lire('/docs/recherche', admin).expect(400);
    });
  });

  // ── 12. Limitation de débit ───────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('PLAFONNE la recherche', async () => {
      // La recherche balaie tout le portail à chaque appel : sans borne,
      // c'est un levier d'épuisement à moindres frais.
      const admin = await session(ADMIN);

      let refuse = false;
      for (let i = 0; i < 70 && !refuse; i += 1) {
        const res = await lire('/docs/recherche?q=scan', admin);
        refuse = res.status === 429;
      }

      expect(refuse).toBe(true);
    });
  });
});
