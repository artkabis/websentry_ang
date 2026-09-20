import {
  DEFAULT_PROFILE,
  PROFILE_EXPORT_VERSION,
  RANKS,
  defaultAnalysisSettings,
} from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

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

describe('Réglages et profils par gamme (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, TESTER]);
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

  /** Requête d'écriture authentifiée, jeton CSRF joint. */
  function write(
    method: 'put' | 'post' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  describe('amorçage', () => {
    it('crée le profil de repli au démarrage', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/profiles')).set('Cookie', admin.cookies).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ profile: DEFAULT_PROFILE, version: 1 });
    });
  });

  describe('GET /registry', () => {
    it('sert le registre à tout compte authentifié', async () => {
      const tester = await session(TESTER);
      const res = await http.get(t.url('/registry')).set('Cookie', tester.cookies).expect(200);

      expect(res.body.checks.length).toBeGreaterThan(20);
      expect(res.body.subChecks.length).toBeGreaterThan(200);
      expect(res.body.checks[0]).toHaveProperty('group');
    });

    it('refuse un anonyme', async () => {
      await http.get(t.url('/registry')).expect(401);
    });

    it('expose la volumétrie du registre', async () => {
      const tester = await session(TESTER);
      const res = await http
        .get(t.url('/registry/stats'))
        .set('Cookie', tester.cookies)
        .expect(200);
      expect(res.body.subChecksTotal).toBeGreaterThan(200);
      expect(res.body.byGroup).toHaveProperty('SEO');
    });
  });

  describe('lecture des profils', () => {
    it('autorise un TESTEUR à consulter — il doit voir les règles de ses scans', async () => {
      const tester = await session(TESTER);
      await http.get(t.url('/profiles')).set('Cookie', tester.cookies).expect(200);
      await http
        .get(t.url(`/profiles/${DEFAULT_PROFILE}`))
        .set('Cookie', tester.cookies)
        .expect(200);
    });

    it('refuse un anonyme', async () => {
      await http.get(t.url('/profiles')).expect(401);
      await http.get(t.url('/profiles/default')).expect(401);
    });

    it('répond 404 pour une gamme inexistante', async () => {
      const tester = await session(TESTER);
      await http.get(t.url('/profiles/inexistante')).set('Cookie', tester.cookies).expect(404);
    });

    it('NORMALISE la gamme reçue — « PREMIUM » atteint « premium »', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      const res = await http
        .get(t.url('/profiles/PREMIUM'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body.profile).toBe('premium');
    });

    it('refuse une gamme qui ne laisse rien après normalisation', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/profiles/!!!')).set('Cookie', admin.cookies).expect(400);
    });
  });

  describe('écriture des profils', () => {
    it('REFUSE un testeur — l’édition est réservée aux administrateurs', async () => {
      const tester = await session(TESTER);
      await write('put', '/profiles/premium', tester)
        .send({ settings: defaultAnalysisSettings() })
        .expect(403);
    });

    it('crée un profil et le renvoie complet', async () => {
      const admin = await session(ADMIN);
      const res = await write('put', '/profiles/premium', admin)
        .send({
          settings: defaultAnalysisSettings(),
          label: 'Premium',
          description: 'Haut de gamme',
        })
        .expect(200);

      expect(res.body).toMatchObject({
        profile: 'premium',
        label: 'Premium',
        description: 'Haut de gamme',
        version: 1,
      });
    });

    it('incrémente la version à chaque écriture', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      const second = await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      expect(second.body.version).toBe(2);
    });

    it('conserve le libellé quand une écriture ne le fournit pas', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), label: 'Libellé métier' })
        .expect(200);

      const res = await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      expect(res.body.label).toBe('Libellé métier');
    });

    it('réinitialise un profil aux valeurs par défaut', async () => {
      const admin = await session(ADMIN);
      const custom = { ...defaultAnalysisSettings(), content: { minWords: 10, warningWords: 20 } };
      await write('put', '/profiles/premium', admin).send({ settings: custom }).expect(200);

      const res = await write('post', '/profiles/premium/reset', admin).expect(200);
      expect(res.body.settings.content).toEqual({ minWords: 300, warningWords: 500 });
    });
  });

  describe('verrouillage optimiste', () => {
    it('accepte une écriture dont la version attendue correspond', async () => {
      const admin = await session(ADMIN);
      const created = await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), expectedVersion: created.body.version })
        .expect(200);
    });

    it('REFUSE 409 une écriture fondée sur une version périmée', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200); // version 1

      // Un second éditeur enregistre entre-temps.
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200); // version 2

      const res = await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), expectedVersion: 1 })
        .expect(409);

      // Le client reçoit de quoi se resynchroniser sans requête supplémentaire.
      expect(res.body.details).toEqual({ currentVersion: 2, expectedVersion: 1 });
    });
  });

  describe('suppression', () => {
    it('supprime une gamme ordinaire', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      await write('delete', '/profiles/premium', admin).expect(204);
      await http.get(t.url('/profiles/premium')).set('Cookie', admin.cookies).expect(404);
    });

    it('PROTÈGE le profil de repli — sans lui, plus aucun repli', async () => {
      const admin = await session(ADMIN);
      await write('delete', `/profiles/${DEFAULT_PROFILE}`, admin).expect(403);
      await http
        .get(t.url(`/profiles/${DEFAULT_PROFILE}`))
        .set('Cookie', admin.cookies)
        .expect(200);
    });

    it('protège le repli même écrit en majuscules', async () => {
      const admin = await session(ADMIN);
      await write('delete', '/profiles/DEFAULT', admin).expect(403);
    });

    it('refuse un testeur', async () => {
      const tester = await session(TESTER);
      await write('delete', '/profiles/premium', tester).expect(403);
    });

    it('répond 404 pour une gamme inexistante', async () => {
      const admin = await session(ADMIN);
      await write('delete', '/profiles/inexistante', admin).expect(404);
    });
  });

  describe('export et import', () => {
    it('exporte une enveloppe autodescriptive avec un nom de fichier borné', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), label: 'Premium' })
        .expect(200);

      const res = await http
        .get(t.url('/profiles/premium/export'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body).toMatchObject({
        formatVersion: PROFILE_EXPORT_VERSION,
        profile: 'premium',
        label: 'Premium',
        sourceVersion: 1,
      });
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="websentry-profil-premium.json"',
      );
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('réimporte une enveloppe dans une AUTRE gamme', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), label: 'Premium' })
        .expect(200);

      const exported = await http
        .get(t.url('/profiles/premium/export'))
        .set('Cookie', admin.cookies)
        .expect(200);

      const res = await write('post', '/profiles/start/import', admin)
        .send({ payload: exported.body })
        .expect(200);

      // La gamme de destination vient de l'URL, jamais du fichier.
      expect(res.body.profile).toBe('start');
      expect(res.body.label).toBe('Premium');
      expect(res.body.version).toBe(1);
    });

    it('REFUSE une enveloppe d’un format inconnu', async () => {
      const admin = await session(ADMIN);
      await write('post', '/profiles/start/import', admin)
        .send({
          payload: {
            formatVersion: 99,
            exportedAt: new Date().toISOString(),
            profile: 'premium',
            label: 'Premium',
            description: null,
            sourceVersion: 1,
            settings: defaultAnalysisSettings(),
          },
        })
        .expect(400);
    });

    it('refuse une enveloppe dont les réglages sont invalides', async () => {
      const admin = await session(ADMIN);
      await write('post', '/profiles/start/import', admin)
        .send({
          payload: {
            formatVersion: PROFILE_EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            profile: 'premium',
            label: 'Premium',
            description: null,
            sourceVersion: 1,
            settings: { inconnu: 'valeur' },
          },
        })
        .expect(400);
    });

    it('refuse un testeur à l’import', async () => {
      const tester = await session(TESTER);
      await write('post', '/profiles/start/import', tester).send({ payload: {} }).expect(403);
    });
  });

  describe('réglages globaux', () => {
    it('exposent le profil de repli', async () => {
      const tester = await session(TESTER);
      const res = await http.get(t.url('/settings')).set('Cookie', tester.cookies).expect(200);
      expect(res.body.profile).toBe(DEFAULT_PROFILE);
    });

    it('écrivent DANS le profil de repli — une seule source de vérité', async () => {
      // La v1 tenait deux fichiers distincts qui pouvaient diverger en silence.
      const admin = await session(ADMIN);
      const custom = { ...defaultAnalysisSettings(), content: { minWords: 42, warningWords: 99 } };

      await http
        .put(t.url('/settings'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .send({ settings: custom })
        .expect(200);

      const viaProfile = await http
        .get(t.url(`/profiles/${DEFAULT_PROFILE}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(viaProfile.body.settings.content).toEqual({ minWords: 42, warningWords: 99 });
    });

    it('refusent un testeur en écriture', async () => {
      const tester = await session(TESTER);
      await write('put', '/settings', tester)
        .send({ settings: defaultAnalysisSettings() })
        .expect(403);
    });

    it('se réinitialisent', async () => {
      const admin = await session(ADMIN);
      const res = await write('post', '/settings/reset', admin).expect(200);
      expect(res.body.settings.content).toEqual({ minWords: 300, warningWords: 500 });
    });
  });

  describe('journal d’audit', () => {
    it.each([
      [
        'profile.created',
        async (a: { cookies: string[]; csrf: string }) => {
          await write('put', '/profiles/premium', a)
            .send({ settings: defaultAnalysisSettings() })
            .expect(200);
        },
      ],
      [
        'profile.updated',
        async (a: { cookies: string[]; csrf: string }) => {
          await write('put', '/profiles/premium', a)
            .send({ settings: defaultAnalysisSettings() })
            .expect(200);
          await write('put', '/profiles/premium', a)
            .send({ settings: defaultAnalysisSettings() })
            .expect(200);
        },
      ],
      [
        'profile.deleted',
        async (a: { cookies: string[]; csrf: string }) => {
          await write('put', '/profiles/premium', a)
            .send({ settings: defaultAnalysisSettings() })
            .expect(200);
          await write('delete', '/profiles/premium', a).expect(204);
        },
      ],
      [
        'profile.reset',
        async (a: { cookies: string[]; csrf: string }) => {
          await write('post', '/settings/reset', a).expect(200);
        },
      ],
    ])('journalise %s', async (action, scenario) => {
      const admin = await session(ADMIN);
      await scenario(admin);
      expect(t.db.auditLog.some(e => e.action === action)).toBe(true);
    });

    it('conserve l’acteur de chaque écriture', async () => {
      const admin = await session(ADMIN);
      await write('put', '/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      const entry = t.db.auditLog.find(e => e.action === 'profile.created');
      expect(entry).toMatchObject({ actorId: 'u-admin', actorName: 'admin' });
    });
  });
});
