import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES, REFRESH_COOKIE_PATH } from '../src/common/constants.js';
import {
  cookieAttributes,
  cookieValue,
  createTestApp,
  type TestApp,
} from './helpers/app.factory.js';

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

describe('Authentification (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, TESTER]);
    http = request(t.app.getHttpServer());
  });

  afterEach(async () => {
    await t.close();
  });

  describe('GET /health', () => {
    it('répond sans authentification', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.body).toEqual({ ok: true, version: '2.0.0' });
    });
  });

  describe('POST /auth/login', () => {
    it('authentifie et pose les quatre cookies', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);

      expect(res.body).toEqual({ role: 'admin', username: 'admin' });

      const setCookie = res.headers['set-cookie'] as unknown as string[];
      expect(cookieValue(setCookie, COOKIES.ACCESS)).toBeTruthy();
      expect(cookieValue(setCookie, COOKIES.REFRESH)).toBeTruthy();
      expect(cookieValue(setCookie, COOKIES.CSRF)).toBeTruthy();
      expect(cookieValue(setCookie, COOKIES.ROLE)).toBe('admin');
    });

    it('rend les jetons INACCESSIBLES au JavaScript', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);

      const setCookie = res.headers['set-cookie'] as unknown as string[];
      expect(cookieAttributes(setCookie, COOKIES.ACCESS)).toMatchObject({
        httponly: true,
        samesite: 'Strict',
      });
      expect(cookieAttributes(setCookie, COOKIES.REFRESH)).toMatchObject({
        httponly: true,
        samesite: 'Strict',
        path: REFRESH_COOKIE_PATH,
      });
    });

    it('laisse ws_csrf LISIBLE — le double-submit l’exige', () => {
      return http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200)
        .then(res => {
          const setCookie = res.headers['set-cookie'] as unknown as string[];
          expect(cookieAttributes(setCookie, COOKIES.CSRF)?.httponly).toBeUndefined();
        });
    });

    it('accepte un identifiant saisi en majuscules', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: 'ADMIN', password: ADMIN.password })
        .expect(200);
    });

    it('refuse un mot de passe incorrect', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: 'mauvais' })
        .expect(401);
      expect(res.body.message).toBe('Identifiants incorrects');
    });

    it('refuse un compte inconnu avec le MÊME message', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: 'inconnu', password: 'peu-importe' })
        .expect(401);
      expect(res.body.message).toBe('Identifiants incorrects');
    });

    it('ne pose AUCUN cookie sur échec', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: 'mauvais' })
        .expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('journalise la connexion réussie', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      expect(t.db.auditLog.some(e => e.action === 'auth.login')).toBe(true);
    });

    it('journalise l’échec de connexion', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: 'mauvais' })
        .expect(401);
      expect(t.db.auditLog.some(e => e.action === 'auth.login_failed')).toBe(true);
    });
  });

  describe('GET /auth/me', () => {
    it('refuse sans authentification', async () => {
      await http.get(t.url('/auth/me')).expect(401);
    });

    it('renvoie le profil au porteur d’un cookie valide', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);

      const res = await http
        .get(t.url('/auth/me'))
        .set('Cookie', login.headers['set-cookie'] as unknown as string[])
        .expect(200);

      expect(res.body).toMatchObject({
        id: 'u-admin',
        username: 'admin',
        rank: RANKS.ADMIN,
        role: 'admin',
        status: 'active',
      });
    });

    it('accepte aussi un porteur Bearer', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      const token = cookieValue(login.headers['set-cookie'] as unknown as string[], COOKIES.ACCESS);

      await http.get(t.url('/auth/me')).set('Authorization', `Bearer ${token}`).expect(200);
    });
  });

  describe('POST /auth/refresh — rotation', () => {
    it('échange le refresh token contre un couple neuf', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];
      const oldRefresh = cookieValue(cookies, COOKIES.REFRESH);

      const res = await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(200);

      const newRefresh = cookieValue(
        res.headers['set-cookie'] as unknown as string[],
        COOKIES.REFRESH,
      );
      expect(newRefresh).toBeTruthy();
      expect(newRefresh).not.toBe(oldRefresh);
    });

    it('REFUSE le rejeu d’un refresh token déjà consommé', async () => {
      // Un jeton volé, présenté après un refresh légitime, tombe sur une session
      // révoquée : c'est la détection de rejeu.
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(200);
      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(401);
    });

    it('refuse sans cookie de rafraîchissement', async () => {
      await http.post(t.url('/auth/refresh')).expect(401);
    });

    it('refuse un refresh token forgé', async () => {
      await http
        .post(t.url('/auth/refresh'))
        .set('Cookie', [`${COOKIES.REFRESH}=jeton-invente`])
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('révoque la session et efface les cookies', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];
      const csrf = cookieValue(cookies, COOKIES.CSRF)!;

      const res = await http
        .post(t.url('/auth/logout'))
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .expect(204);

      const cleared = res.headers['set-cookie'] as unknown as string[];
      expect(cookieValue(cleared, COOKIES.ACCESS)).toBe('');
      expect(cookieValue(cleared, COOKIES.REFRESH)).toBe('');
    });

    it('invalide le refresh token après déconnexion', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];
      const csrf = cookieValue(cookies, COOKIES.CSRF)!;

      await http
        .post(t.url('/auth/logout'))
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .expect(204);

      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(401);
    });

    it('refuse une déconnexion non authentifiée', async () => {
      await http.post(t.url('/auth/logout')).expect(401);
    });
  });

  describe('révocation par token_version', () => {
    it('invalide immédiatement un access token encore dans sa fenêtre de validité', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(200);

      // Révocation côté serveur, sans attendre l'expiration du jeton.
      t.db.users.get('u-admin')!.token_version += 1;

      await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(401);
    });
  });

  describe('statut du compte', () => {
    it('refuse la connexion d’un compte suspendu', async () => {
      t.db.users.get('u-test')!.status = 'suspended';
      await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(403);
    });

    it('refuse un jeton valide dont le compte a été suspendu depuis', async () => {
      const login = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      t.db.users.get('u-test')!.status = 'suspended';
      await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(401);
    });
  });
});
