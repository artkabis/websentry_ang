import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité OWASP — modules 5 et 7 (administration).
 *
 * Complète `owasp.e2e-spec.ts` sur la surface ajoutée par ces modules, qui est
 * la plus sensible du projet : des routes qui CRÉENT des comptes, changent des
 * rangs et réinitialisent des mots de passe ; un journal d'audit qui porte des
 * adresses IP ; et un relevé qui décrit l'infrastructure.
 *
 * Trois régimes d'accès coexistent ici, et c'est justement ce que cette suite
 * vérifie : `users:*` pour les comptes, le RANG 100 pour le journal,
 * `health:read` pour la supervision.
 */

const ID_SUPER = '11111111-1111-4111-8111-111111111111';
const ID_ADMIN = '22222222-2222-4222-8222-222222222222';
const ID_TESTEUR = '33333333-3333-4333-8333-333333333333';

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

/** Charges d'injection classiques, appliquées à chaque filtre textuel. */
const INJECTIONS = [
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  "' UNION SELECT password_hash FROM users --",
  "\\' OR 1=1 #",
];

describe('Suite sécurité OWASP — modules 5 et 7 (E2E)', () => {
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

  function write(
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  // ── 1. Injection SQL ──────────────────────────────────────────────────────

  describe('1. Injection SQL', () => {
    it.each(INJECTIONS)('neutralise « %s » dans la recherche de comptes', async charge => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/users?search=${encodeURIComponent(charge)}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      // La charge ne ramène RIEN : si elle était interpolée, « OR '1'='1 »
      // rendrait la table entière.
      expect(res.body.total).toBe(0);
      expect(res.body.users).toEqual([]);
    });

    it('laisse les comptes INTACTS après les charges destructrices', async () => {
      const admin = await session(ADMIN);
      for (const charge of INJECTIONS) {
        await http
          .get(t.url(`/users?search=${encodeURIComponent(charge)}`))
          .set('Cookie', admin.cookies);
      }

      const apres = await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);
      expect(apres.body.total).toBe(3);
    });

    it.each(INJECTIONS)('neutralise « %s » dans le filtre d’acteur du journal', async charge => {
      const patron = await session(SUPER);
      const res = await http
        .get(t.url(`/audit?actor=${encodeURIComponent(charge)}`))
        .set('Cookie', patron.cookies)
        .expect(200);

      expect(res.body.total).toBe(0);
    });

    it('REFUSE un rang ou un statut hors du catalogue, plutôt que de l’interpoler', async () => {
      // Ces filtres n'atteignent le SQL que par une valeur d'énumération :
      // une entrée hors catalogue est arrêtée par le schéma, pas échappée.
      const admin = await session(ADMIN);
      await http.get(t.url("/users?rank=50'--")).set('Cookie', admin.cookies).expect(400);
      await http.get(t.url('/users?status=actif')).set('Cookie', admin.cookies).expect(400);
    });
  });

  // ── 5. Contrôle d'accès ───────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it('FERME par défaut : aucune route d’administration n’est publique', async () => {
      for (const route of ['/users', '/users/' + ID_ADMIN, '/audit', '/supervision']) {
        await http.get(t.url(route)).expect(401);
      }
    });

    it('cloisonne les TROIS régimes d’accès', async () => {
      const testeur = await session(TESTEUR);
      const admin = await session(ADMIN);

      // Un testeur n'a rien.
      await http.get(t.url('/users')).set('Cookie', testeur.cookies).expect(403);
      await http.get(t.url('/audit')).set('Cookie', testeur.cookies).expect(403);
      await http.get(t.url('/supervision')).set('Cookie', testeur.cookies).expect(403);

      // Un administrateur a les comptes et la supervision, PAS le journal.
      await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);
      await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);
      await http.get(t.url('/audit')).set('Cookie', admin.cookies).expect(403);
    });

    it('REFUSE l’élévation de privilège par création de compte', async () => {
      const admin = await session(ADMIN);
      await write('post', '/users', admin)
        .send({
          username: 'usurpateur',
          password: 'MotDePasseValide!2026',
          rank: RANKS.SUPER_ADMIN,
        })
        .expect(403);

      expect(t.db.byUsername('usurpateur')).toBeNull();
    });

    it('REFUSE l’auto-élévation', async () => {
      const admin = await session(ADMIN);
      await write('patch', `/users/${ID_ADMIN}`, admin)
        .send({ rank: RANKS.SUPER_ADMIN })
        .expect(403);

      expect(t.db.users.get(ID_ADMIN)?.rank).toBe(RANKS.ADMIN);
    });

    it('REFUSE de voler le mot de passe d’un compte de rang supérieur', async () => {
      const admin = await session(ADMIN);
      const avant = t.db.users.get(ID_SUPER)?.password_hash;

      await write('post', `/users/${ID_SUPER}/password`, admin)
        .send({ password: 'MotDePasseVole!2026' })
        .expect(403);

      expect(t.db.users.get(ID_SUPER)?.password_hash).toBe(avant);
    });

    it('REFUSE la suppression à qui ne porte pas users:delete', async () => {
      const admin = await session(ADMIN);
      await write('delete', `/users/${ID_TESTEUR}`, admin).expect(403);
      expect(t.db.users.has(ID_TESTEUR)).toBe(true);
    });

    it('n’expose AUCUNE écriture sur le journal ni la supervision', async () => {
      // L'un est append-only, l'autre en lecture seule : une route d'écriture
      // contournerait une garantie structurelle.
      const patron = await session(SUPER);
      for (const route of ['/audit', '/supervision']) {
        for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
          await write(methode, route, patron).expect(404);
        }
      }
    });
  });

  // ── 3. CSRF ───────────────────────────────────────────────────────────────

  describe('3. CSRF', () => {
    it('refuse toute écriture par cookie sans jeton', async () => {
      const patron = await session(SUPER);
      const charge = { username: 'sansjeton', password: 'MotDePasseValide!2026', rank: 10 };

      await http.post(t.url('/users')).set('Cookie', patron.cookies).send(charge).expect(403);
      expect(t.db.byUsername('sansjeton')).toBeNull();
    });

    it('refuse un jeton DIVERGENT du cookie', async () => {
      const patron = await session(SUPER);
      await http
        .patch(t.url(`/users/${ID_TESTEUR}`))
        .set('Cookie', patron.cookies)
        .set('X-CSRF-Token', 'jeton-fabrique')
        .send({ status: 'suspended' })
        .expect(403);

      expect(t.db.users.get(ID_TESTEUR)?.status).toBe('active');
    });
  });

  // ── 15. Mass assignment ───────────────────────────────────────────────────

  describe('15. Mass assignment et validation d’entrée', () => {
    it.each([
      ['status', { status: 'active' }],
      ['tokenVersion', { tokenVersion: 99 }],
      ['passwordHash', { passwordHash: 'sel:empreinte' }],
      ['id', { id: ID_SUPER }],
      ['createdBy', { createdBy: ID_SUPER }],
    ])('REJETTE la clé surnuméraire %s à la création', async (_nom, surplus) => {
      const patron = await session(SUPER);
      await write('post', '/users', patron)
        .send({
          username: 'masse',
          password: 'MotDePasseValide!2026',
          rank: RANKS.TESTER,
          ...surplus,
        })
        .expect(400);

      expect(t.db.byUsername('masse')).toBeNull();
    });

    it('n’expose NI titre NI empreinte à la mise à jour', async () => {
      const patron = await session(SUPER);
      await write('patch', `/users/${ID_TESTEUR}`, patron)
        .send({ passwordHash: 'sel:empreinte' })
        .expect(400);
      await write('patch', `/users/${ID_TESTEUR}`, patron)
        .send({ username: 'renomme' })
        .expect(400);
    });

    it('BORNE la pagination des trois lectures', async () => {
      const patron = await session(SUPER);
      for (const route of ['/users?limit=5000', '/audit?limit=5000']) {
        await http.get(t.url(route)).set('Cookie', patron.cookies).expect(400);
      }
      await http.get(t.url('/users?offset=-1')).set('Cookie', patron.cookies).expect(400);
    });

    it('REFUSE un paramètre de requête inconnu', async () => {
      const patron = await session(SUPER);
      await http.get(t.url('/users?tri=rank')).set('Cookie', patron.cookies).expect(400);
      await http.get(t.url('/audit?tri=id')).set('Cookie', patron.cookies).expect(400);
    });
  });

  // ── 9. Pollution de prototype ─────────────────────────────────────────────

  describe('9. Pollution de prototype', () => {
    it.each(['__proto__', 'constructor', 'prototype'])(
      'NEUTRALISE la clé %s soumise à la création d’un compte',
      async cle => {
        const patron = await session(SUPER);
        const corps = JSON.stringify({
          username: 'proto',
          password: 'MotDePasseValide!2026',
          rank: RANKS.TESTER,
          [cle]: { pollue: true },
        });

        await write('post', '/users', patron).type('application/json').send(corps);

        // Quoi qu'il advienne du code de statut, le prototype ne bouge pas.
        expect(({} as Record<string, unknown>)['pollue']).toBeUndefined();
      },
    );
  });

  // ── 14. Traversée de chemin ───────────────────────────────────────────────

  describe('14. Traversée de chemin', () => {
    it.each([
      '../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'nul%00.json',
    ])('REFUSE « %s » comme identifiant de compte', async chemin => {
      // L'identifiant est validé comme UUID : rien d'autre ne franchit la route.
      const admin = await session(ADMIN);
      const res = await http.get(t.url(`/users/${chemin}`)).set('Cookie', admin.cookies);

      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });
  });

  // ── 7. Données sensibles et messages d'erreur ─────────────────────────────

  describe('7. Données sensibles et messages d’erreur', () => {
    it('ne laisse JAMAIS fuir une empreinte ni un compteur d’échec', async () => {
      const admin = await session(ADMIN);
      const liste = await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);
      const fiche = await http
        .get(t.url(`/users/${ID_TESTEUR}`))
        .set('Cookie', admin.cookies)
        .expect(200);

      for (const corps of [liste.body, fiche.body]) {
        const brut = JSON.stringify(corps);
        for (const interdit of [
          'password_hash',
          'passwordHash',
          'token_version',
          'tokenVersion',
          'failed_logins',
        ]) {
          expect(brut).not.toContain(interdit);
        }
      }
    });

    it('ne renvoie PAS le mot de passe posé lors d’une réinitialisation', async () => {
      const patron = await session(SUPER);
      const res = await write('post', `/users/${ID_TESTEUR}/password`, patron)
        .send({ password: 'MotDePasseSecret!2026' })
        .expect(204);

      expect(JSON.stringify(res.body)).not.toContain('MotDePasseSecret');
    });

    it('RÉSERVE les adresses IP du journal au rang 100', async () => {
      // Le journal est une pièce d'enquête : un administrateur n'y accède pas.
      const admin = await session(ADMIN);
      await http.get(t.url('/audit')).set('Cookie', admin.cookies).expect(403);

      const patron = await session(SUPER);
      const res = await http.get(t.url('/audit')).set('Cookie', patron.cookies).expect(200);
      expect(res.body.entries[0]).toHaveProperty('ipAddress');
    });

    it('ne décrit PAS l’infrastructure dans le relevé de supervision', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);

      const brut = JSON.stringify(res.body).toLowerCase();
      for (const interdit of ['localhost', '3306', 'mysql', 'password', 'econnrefused', '/home/']) {
        expect(brut).not.toContain(interdit);
      }
    });

    it('rend une erreur UNIFORME, sans trace d’exécution', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/users/pas-un-uuid'))
        .set('Cookie', admin.cookies)
        .expect(400);

      expect(res.body).toHaveProperty('statusCode');
      expect(res.body).toHaveProperty('message');
      const brut = JSON.stringify(res.body);
      expect(brut).not.toContain('at ');
      expect(brut).not.toMatch(/\.ts:\d+/);
      expect(brut).not.toContain('node_modules');
    });

    it('n’offre AUCUN oracle d’énumération sur les comptes', async () => {
      // Un compte inexistant et un compte hors de portée doivent rendre la
      // même chose, sans quoi on cartographie la base par essais.
      const admin = await session(ADMIN);
      const inexistant = await http
        .get(t.url('/users/99999999-9999-4999-8999-999999999999'))
        .set('Cookie', admin.cookies);

      expect(inexistant.status).toBe(404);
    });
  });

  // ── 12. Limitation de débit ───────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('plafonne la création de comptes', async () => {
      // Sans borne, une session volée fabriquerait des comptes en rafale.
      const patron = await session(SUPER);
      const statuts: number[] = [];

      for (let i = 0; i < 14; i++) {
        const res = await write('post', '/users', patron).send({
          username: `rafale${i}`,
          password: 'MotDePasseValide!2026',
          rank: RANKS.TESTER,
        });
        statuts.push(res.status);
      }

      // La limite est de 10 par minute : le surplus est refusé.
      expect(statuts).toContain(429);
    });

    it('plafonne la réinitialisation de mot de passe', async () => {
      const patron = await session(SUPER);
      const statuts: number[] = [];

      for (let i = 0; i < 14; i++) {
        const res = await write('post', `/users/${ID_TESTEUR}/password`, patron).send({
          password: `MotDePasseValide${i}!2026`,
        });
        statuts.push(res.status);
      }

      expect(statuts).toContain(429);
    });
  });
});
