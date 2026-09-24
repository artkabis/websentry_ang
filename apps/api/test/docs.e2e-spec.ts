import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

const ID_ADMIN = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';

const ADMIN = {
  id: ID_ADMIN,
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const BOB = { id: ID_BOB, username: 'bob', password: 'MotDePasseBob!2026', rank: RANKS.TESTER };

describe('Portail documentation (E2E)', () => {
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

  describe('accès', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/docs')).expect(401);
      await http.get(t.url('/docs/premiers-pas')).expect(401);
    });

    it('REFUSE qui ne détient pas docs:read', async () => {
      const bob = await session(BOB);
      await lire('/docs', bob).expect(403);
    });

    it('OUVRE à un administrateur, qui le détient par défaut', async () => {
      const admin = await session(ADMIN);
      await lire('/docs', admin).expect(200);
    });

    it('accorde docs:read à un rang inférieur par permission EXPLICITE', async () => {
      t.db.permissions.set(ID_BOB, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]);
      const bob = await session(BOB);

      await lire('/docs', bob).expect(200);
    });
  });

  describe('sommaire', () => {
    it('groupe les pages par section, prise en main d’abord', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs', admin).expect(200);

      expect(res.body.sections[0].section).toBe('Prise en main');
      expect(res.body.sections[0].pages.length).toBeGreaterThan(0);
    });

    it('porte un RÉSUMÉ par page, pour situer sans ouvrir', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs', admin).expect(200);

      const premiere = res.body.sections[0].pages[0];
      expect(premiere.resume.length).toBeGreaterThan(10);
    });

    it('n’expose AUCUN chemin de fichier', async () => {
      const admin = await session(ADMIN);
      const corps = JSON.stringify((await lire('/docs', admin).expect(200)).body);

      expect(corps).not.toContain('.md');
      expect(corps).not.toContain('/src/');
    });
  });

  describe('lecture d’une page', () => {
    it('rend des BLOCS, jamais du HTML', async () => {
      // C'est la garantie du module : l'interface dessine une structure, elle
      // n'injecte pas du balisage.
      const admin = await session(ADMIN);
      const res = await lire('/docs/premiers-pas', admin).expect(200);

      expect(res.body.blocs.length).toBeGreaterThan(0);
      expect(res.body).not.toHaveProperty('html');
      expect(JSON.stringify(res.body)).not.toContain('<p>');
    });

    it('rend 404 sur une page inconnue', async () => {
      const admin = await session(ADMIN);
      await lire('/docs/inexistante', admin).expect(404);
    });

    it('REFUSE un identifiant qui n’en est pas un', async () => {
      const admin = await session(ADMIN);
      for (const slug of ['Majuscule', 'avec espace', 'premiers-pas.md']) {
        const res = await lire(`/docs/${encodeURIComponent(slug)}`, admin);
        expect([400, 404]).toContain(res.status);
      }
    });
  });

  describe('recherche', () => {
    it('trouve une page par son contenu', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/recherche?q=pondération', admin).expect(200);

      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.resultats[0].extrait.length).toBeGreaterThan(0);
    });

    it('IGNORE les accents', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/recherche?q=donnees', admin).expect(200);

      expect(res.body.total).toBeGreaterThan(0);
    });

    it('EXIGE au moins deux caractères', async () => {
      // Une lettre seule ramènerait tout le portail, pour rien.
      const admin = await session(ADMIN);
      await lire('/docs/recherche?q=a', admin).expect(400);
    });

    it('ne se fait PAS passer pour une page', async () => {
      // « recherche » est un identifiant valide : c'est l'ordre de déclaration
      // qui décide laquelle des deux routes répond.
      const admin = await session(ADMIN);
      const res = await lire('/docs/recherche?q=scan', admin).expect(200);

      expect(res.body).toHaveProperty('resultats');
      expect(res.body).not.toHaveProperty('blocs');
    });

    it('rend une réponse VIDE quand rien ne correspond', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/docs/recherche?q=zzzintrouvable', admin).expect(200);

      expect(res.body).toEqual({ q: 'zzzintrouvable', resultats: [], total: 0 });
    });
  });

  describe('ce que le portail n’offre pas', () => {
    it('n’expose AUCUNE écriture', async () => {
      // Les pages vivent dans le dépôt : elles se modifient par une revue de
      // code, pas par une route.
      const admin = await session(ADMIN);

      for (const chemin of ['/docs', '/docs/premiers-pas']) {
        for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
          await http[methode](t.url(chemin))
            .set('Cookie', admin.cookies)
            .set('X-CSRF-Token', admin.csrf)
            .expect(404);
        }
      }
    });
  });
});
