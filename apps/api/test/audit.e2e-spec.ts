import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

const ID_SUPER = '11111111-1111-4111-8111-111111111111';
const ID_ADMIN = '22222222-2222-4222-8222-222222222222';
const ID_TESTEUR = '44444444-4444-4444-8444-444444444444';

const SUPER = {
  id: ID_SUPER,
  username: 'patron',
  password: 'MotDePassePatron!2026',
  rank: RANKS.SUPER_ADMIN,
};
const ADMIN = {
  id: ID_ADMIN,
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const TESTEUR = {
  id: ID_TESTEUR,
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

describe('Journal d’audit (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([SUPER, ADMIN, TESTEUR]);
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

  describe('accès', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/audit')).expect(401);
    });

    it('REFUSE un administrateur — le journal est réservé au rang 100', async () => {
      // `audit:read` existe au catalogue mais n'est accordable à personne :
      // c'est le rang qui garde, pas la permission.
      const admin = await session(ADMIN);
      await http.get(t.url('/audit')).set('Cookie', admin.cookies).expect(403);
    });

    it('refuse un testeur', async () => {
      const testeur = await session(TESTEUR);
      await http.get(t.url('/audit')).set('Cookie', testeur.cookies).expect(403);
    });

    it('sert le journal à un super administrateur', async () => {
      const patron = await session(SUPER);
      const res = await http.get(t.url('/audit')).set('Cookie', patron.cookies).expect(200);

      expect(res.body).toHaveProperty('entries');
      expect(res.body).toHaveProperty('total');
    });
  });

  describe('contenu', () => {
    it('trace les connexions, la plus récente d’abord', async () => {
      await session(ADMIN);
      const patron = await session(SUPER);

      const res = await http.get(t.url('/audit')).set('Cookie', patron.cookies).expect(200);
      const actions = res.body.entries.map((e: { action: string }) => e.action);

      expect(actions).toContain('auth.login');
      expect(res.body.entries[0].actorName).toBe('patron');
    });

    it('trace les écritures sur les comptes, SANS le mot de passe', async () => {
      const patron = await session(SUPER);
      await http
        .post(t.url('/users'))
        .set('Cookie', patron.cookies)
        .set('X-CSRF-Token', patron.csrf)
        .send({ username: 'tracee', password: 'MotDePasseTraçable!2026', rank: RANKS.TESTER })
        .expect(201);

      const res = await http
        .get(t.url('/audit?action=user.'))
        .set('Cookie', patron.cookies)
        .expect(200);

      expect(res.body.entries[0]).toMatchObject({ action: 'user.create', targetType: 'user' });
      expect(JSON.stringify(res.body)).not.toContain('MotDePasseTraçable!2026');
    });
  });

  describe('filtres et bornes', () => {
    it('filtre par ACTEUR', async () => {
      await session(ADMIN);
      const patron = await session(SUPER);

      const res = await http
        .get(t.url('/audit?actor=admin'))
        .set('Cookie', patron.cookies)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].actorName).toBe('admin');
    });

    it('filtre l’action par PRÉFIXE', async () => {
      const patron = await session(SUPER);
      const res = await http
        .get(t.url('/audit?action=auth.'))
        .set('Cookie', patron.cookies)
        .expect(200);

      expect(res.body.entries.length).toBeGreaterThan(0);
      for (const entree of res.body.entries as Array<{ action: string }>) {
        expect(entree.action.startsWith('auth.')).toBe(true);
      }
    });

    it('annonce le total AVANT pagination', async () => {
      await session(ADMIN);
      await session(TESTEUR);
      const patron = await session(SUPER);

      const res = await http.get(t.url('/audit?limit=1')).set('Cookie', patron.cookies).expect(200);

      expect(res.body.entries).toHaveLength(1);
      expect(res.body.total).toBeGreaterThan(1);
    });

    it('REFUSE une limite hors bornes — pas d’extraction massive', async () => {
      const patron = await session(SUPER);
      await http.get(t.url('/audit?limit=5000')).set('Cookie', patron.cookies).expect(400);
      await http.get(t.url('/audit?offset=-1')).set('Cookie', patron.cookies).expect(400);
    });

    it('REFUSE une date mal formée plutôt que de l’ignorer', async () => {
      // L'ignorer afficherait un résultat non filtré sous un filtre affiché.
      const patron = await session(SUPER);
      await http.get(t.url('/audit?from=01/2026')).set('Cookie', patron.cookies).expect(400);
    });

    it('REFUSE un paramètre inconnu', async () => {
      const patron = await session(SUPER);
      await http.get(t.url('/audit?tri=id')).set('Cookie', patron.cookies).expect(400);
    });
  });

  describe('append-only', () => {
    it('n’expose NI purge NI correction', async () => {
      // Le dépôt n'a ni UPDATE ni DELETE : la contrainte est structurelle, et
      // aucune route ne doit venir la contourner.
      const patron = await session(SUPER);
      for (const methode of ['delete', 'put', 'patch', 'post'] as const) {
        await http[methode](t.url('/audit'))
          .set('Cookie', patron.cookies)
          .set('X-CSRF-Token', patron.csrf)
          .expect(404);
      }
    });
  });
});
