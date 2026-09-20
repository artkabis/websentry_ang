import { RANKS, defaultAnalysisSettings, PROFILE_EXPORT_VERSION } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 2 (réglages et profils par gamme).
 *
 * Complète `owasp.e2e-spec.ts` sur la surface ajoutée par ce module : des
 * routes d'ÉCRITURE administrateur, un dictionnaire à clés libres, un nom de
 * gamme qui circule jusqu'à un en-tête HTTP, et un import de fichier.
 */

const SUPER = {
  id: 'u-super',
  username: 'super',
  password: 'MotDePasseSuper!2026',
  rank: RANKS.SUPER_ADMIN,
};
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

describe('Suite sécurité OWASP — module 2 (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([SUPER, ADMIN, EDITOR, TESTER]);
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

  function put(path: string, auth: { cookies: string[]; csrf: string }) {
    return http.put(t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  // ── 1 ────────────────────────────────────────────────────────────────────
  describe('1. Injection SQL', () => {
    it.each([
      "premium'; DROP TABLE settings_profiles; --",
      "' OR '1'='1",
      "premium' UNION SELECT password_hash FROM users --",
    ])('ne se laisse pas détourner par la charge %s dans la gamme', async payload => {
      const admin = await session(ADMIN);
      // La charge est normalisée puis passée en paramètre : elle ne peut
      // atteindre ni le texte de la requête ni un chemin de fichier.
      const res = await http
        .get(t.url(`/profiles/${encodeURIComponent(payload)}`))
        .set('Cookie', admin.cookies);

      expect([400, 404]).toContain(res.status);
      // Le profil de repli est toujours là : rien n'a été détruit.
      await http.get(t.url('/profiles/default')).set('Cookie', admin.cookies).expect(200);
    });
  });

  // ── 5 ────────────────────────────────────────────────────────────────────
  describe('5. Contrôle d’accès défaillant', () => {
    it.each([
      ['tester', TESTER],
      ['editor', EDITOR],
    ])('REFUSE l’écriture de profil à un %s', async (_label, user) => {
      const auth = await session(user);
      await put('/profiles/premium', auth)
        .send({ settings: defaultAnalysisSettings() })
        .expect(403);
    });

    it('refuse l’écriture des réglages globaux à un editor', async () => {
      const auth = await session(EDITOR);
      await put('/settings', auth).send({ settings: defaultAnalysisSettings() }).expect(403);
    });

    it('autorise l’administrateur et le super_admin', async () => {
      for (const user of [ADMIN, SUPER]) {
        const auth = await session(user);
        await put('/profiles/premium', auth)
          .send({ settings: defaultAnalysisSettings() })
          .expect(200);
      }
    });

    it('ferme toutes les routes du module à un anonyme', async () => {
      await http.get(t.url('/profiles')).expect(401);
      await http.get(t.url('/settings')).expect(401);
      await http.get(t.url('/registry')).expect(401);
      await http.put(t.url('/settings')).send({}).expect(401);
      await http.delete(t.url('/profiles/premium')).expect(401);
    });

    it('ne laisse pas un testeur élever ses droits via le cookie ws_role', async () => {
      const tester = await session(TESTER);
      const forged = [
        ...tester.cookies.filter(c => !c.startsWith(COOKIES.ROLE)),
        `${COOKIES.ROLE}=admin`,
      ];
      await http
        .put(t.url('/profiles/premium'))
        .set('Cookie', forged)
        .set('X-CSRF-Token', tester.csrf)
        .send({ settings: defaultAnalysisSettings() })
        .expect(403);
    });
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  describe('3. CSRF', () => {
    it.each([
      [
        'PUT /profiles/:gamme',
        (c: string[]) =>
          http
            .put(t.url('/profiles/premium'))
            .set('Cookie', c)
            .send({ settings: defaultAnalysisSettings() }),
      ],
      [
        'PUT /settings',
        (c: string[]) =>
          http
            .put(t.url('/settings'))
            .set('Cookie', c)
            .send({ settings: defaultAnalysisSettings() }),
      ],
      [
        'POST /settings/reset',
        (c: string[]) => http.post(t.url('/settings/reset')).set('Cookie', c),
      ],
      [
        'DELETE /profiles/:gamme',
        (c: string[]) => http.delete(t.url('/profiles/premium')).set('Cookie', c),
      ],
      [
        'POST /profiles/:gamme/import',
        (c: string[]) =>
          http.post(t.url('/profiles/start/import')).set('Cookie', c).send({ payload: {} }),
      ],
    ])('REFUSE %s sans jeton CSRF', async (_label, call) => {
      const admin = await session(ADMIN);
      await call(admin.cookies).expect(403);
    });

    it('laisse passer une LECTURE sans jeton CSRF', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/profiles')).set('Cookie', admin.cookies).expect(200);
    });
  });

  // ── 15 ───────────────────────────────────────────────────────────────────
  describe('15. Mass assignment et validation d’entrée', () => {
    it('REJETTE une tentative de forcer la version ou l’auteur', async () => {
      // `version` et `updatedBy` sont gérés par le serveur : les accepter
      // permettrait de contourner le verrouillage optimiste et de falsifier la
      // traçabilité.
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), version: 99, updatedBy: 'quelqu-un-dautre' })
        .expect(400);
    });

    it.each([
      [{}, 'corps vide'],
      [{ settings: null }, 'réglages nuls'],
      [{ settings: 'texte' }, 'réglages non objet'],
      [{ settings: { inconnu: 1 } }, 'clé de réglage inconnue'],
      [{ settings: defaultAnalysisSettings(), expectedVersion: -1 }, 'version négative'],
      [{ settings: defaultAnalysisSettings(), label: '' }, 'libellé vide'],
      [{ settings: defaultAnalysisSettings(), label: 'x'.repeat(200) }, 'libellé trop long'],
    ])('refuse 400 pour %#  (%s)', async (body, _label) => {
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin).send(body).expect(400);
    });

    it('REFUSE un intervalle inversé — le critère serait insatisfiable', async () => {
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin)
        .send({
          settings: {
            ...defaultAnalysisSettings(),
            meta: { title: { min: 90, max: 10 }, description: { min: 1, max: 2 } },
          },
        })
        .expect(400);
    });
  });

  // ── 9 ────────────────────────────────────────────────────────────────────
  describe('9. Pollution de prototype', () => {
    /**
     * TROIS couches interviennent, et le test porte sur le RÉSULTAT plutôt que
     * sur l'une d'elles :
     *
     *   1. Fastify refuse `__proto__` dès l'analyse du corps JSON (400) ;
     *   2. le `StandardSchemaValidationPipe` de Nest retire `constructor` et
     *      `prototype` avant validation, si bien que la requête aboutit — mais
     *      débarrassée de la clé ;
     *   3. le schéma partagé les rejette explicitement, ce qui couvre les
     *      chemins qui n'empruntent pas le pipe (import depuis un fichier,
     *      appel direct au service).
     *
     * Assertion utile : quoi qu'il advienne du code de statut, la clé dangereuse
     * ne doit jamais être stockée, et le prototype ne doit jamais bouger.
     */
    it.each(['__proto__', 'constructor', 'prototype'])(
      'NEUTRALISE la clé %s soumise dans checkWeights',
      async key => {
        const admin = await session(ADMIN);
        const body = JSON.stringify({
          settings: { ...defaultAnalysisSettings(), checkWeights: { [key]: 2 } },
        });

        const res = await put('/profiles/premium', admin)
          .set('Content-Type', 'application/json')
          .send(body);

        expect([200, 400]).toContain(res.status);

        // Rien de dangereux n'a été persisté.
        const stored = t.db.profiles.get('premium');
        const weights = (stored?.settings as { checkWeights?: Record<string, unknown> })
          ?.checkWeights;
        expect(weights ?? {}).not.toHaveProperty(key);

        // Et le prototype du processus est intact.
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype).not.toHaveProperty('2');
      },
    );

    it('le SCHÉMA rejette ces clés, pour les chemins qui n’empruntent pas le pipe', async () => {
      // L'import valide l'enveloppe au niveau du service : c'est là que la
      // troisième couche compte réellement.
      const admin = await session(ADMIN);
      const res = await http
        .post(t.url('/profiles/start/import'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            payload: {
              formatVersion: PROFILE_EXPORT_VERSION,
              exportedAt: new Date().toISOString(),
              profile: 'premium',
              label: 'Premium',
              description: null,
              sourceVersion: 1,
              settings: { ...defaultAnalysisSettings(), checkWeights: { prototype: 2 } },
            },
          }),
        );

      expect([200, 400]).toContain(res.status);
      const stored = t.db.profiles.get('start');
      const weights = (stored?.settings as { checkWeights?: Record<string, unknown> })
        ?.checkWeights;
      expect(weights ?? {}).not.toHaveProperty('prototype');
    });

    it('signale un identifiant de critère inconnu au lieu de l’ignorer', async () => {
      // Une suppression silencieuse laisserait l'administrateur croire qu'il a
      // enregistré un réglage qui n'existe pas.
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin)
        .send({ settings: { ...defaultAnalysisSettings(), checkWeights: { metas_minuscule: 2 } } })
        .expect(400);
    });
  });

  // ── 14 ───────────────────────────────────────────────────────────────────
  describe('14. Traversée de chemin', () => {
    it.each([
      '../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '....//....//etc/passwd',
      'premium/../default',
    ])('neutralise %s dans la gamme', async payload => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/profiles/${encodeURIComponent(payload)}`))
        .set('Cookie', admin.cookies);

      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });

    it('BORNE le nom de fichier d’export — un en-tête est un vecteur d’injection', async () => {
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      const res = await http
        .get(t.url('/profiles/PREMIUM%20Plus!/export'))
        .set('Cookie', admin.cookies);

      if (res.status === 200) {
        const disposition = res.headers['content-disposition'] as string;
        // Aucun saut de ligne ni guillemet ne peut s'échapper de l'en-tête.
        expect(disposition).toMatch(/^attachment; filename="websentry-profil-[a-z0-9-]+\.json"$/);
      } else {
        expect([400, 404]).toContain(res.status);
      }
    });
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  describe('7. Données sensibles et messages d’erreur', () => {
    it('n’expose aucun détail interne sur un conflit de version', async () => {
      const admin = await session(ADMIN);
      await put('/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);
      await put('/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings() })
        .expect(200);

      const res = await put('/profiles/premium', admin)
        .send({ settings: defaultAnalysisSettings(), expectedVersion: 1 })
        .expect(409);

      // Le canal `details` est borné : versions uniquement, rien d'autre.
      expect(Object.keys(res.body.details).sort()).toEqual(['currentVersion', 'expectedVersion']);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/SELECT |UPDATE |settings_profiles|node_modules|\.ts:/);
    });

    it('ne divulgue pas la structure de la base sur une gamme invalide', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/profiles/!!!')).set('Cookie', admin.cookies).expect(400);
      expect(JSON.stringify(res.body)).not.toMatch(/ER_|mysql|mariadb|settings_profiles/i);
    });
  });

  // ── 12 ───────────────────────────────────────────────────────────────────
  describe('12. Limitation de débit', () => {
    it('plafonne les écritures de profil', async () => {
      const admin = await session(ADMIN);
      const statuses: number[] = [];

      for (let i = 0; i < 14; i++) {
        const res = await put('/profiles/premium', admin).send({
          settings: defaultAnalysisSettings(),
        });
        statuses.push(res.status);
      }

      // La limite est de 10 par minute : le surplus est refusé.
      expect(statuses).toContain(429);
    });
  });

  // ── Import ───────────────────────────────────────────────────────────────
  describe('Import de fichier', () => {
    function envelope(over: Record<string, unknown> = {}) {
      return {
        formatVersion: PROFILE_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        profile: 'premium',
        label: 'Premium',
        description: null,
        sourceVersion: 1,
        settings: defaultAnalysisSettings(),
        ...over,
      };
    }

    it('REFUSE une enveloppe portant une clé surnuméraire', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/profiles/start/import'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .send({ payload: envelope({ malveillant: true }) })
        .expect(400);
    });

    it('refuse une gamme non normalisée dans l’enveloppe', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/profiles/start/import'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .send({ payload: envelope({ profile: '../../etc/passwd' }) })
        .expect(400);
    });

    it('refuse une enveloppe surdimensionnée', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .post(t.url('/profiles/start/import'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .send({
          payload: envelope({
            settings: {
              ...defaultAnalysisSettings(),
              orphanExclusions: Array.from({ length: 50_000 }, (_, i) => `motif-${i}`),
            },
          }),
        });

      expect([400, 413]).toContain(res.status);
    });
  });
});
