import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 9 (analytics d'usage et gouvernance).
 *
 * La surface est petite — deux lectures — mais elle est particulière : c'est
 * le seul module dont la RAISON D'ÊTRE est de parler des personnes sans les
 * nommer. Le risque n'est donc pas qu'il laisse écrire, c'est qu'il laisse
 * RÉIDENTIFIER. Les tests portent d'abord là-dessus.
 */

const ID_ADMIN = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';
const ID_CARLA = '33333333-3333-4333-8333-333333333333';

const ADMIN = {
  id: ID_ADMIN,
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const BOB = { id: ID_BOB, username: 'bob', password: 'MotDePasseBob!2026', rank: RANKS.TESTER };
const CARLA = {
  id: ID_CARLA,
  username: 'carla',
  password: 'MotDePasseCarla!2026',
  rank: RANKS.EDITOR,
};

describe('Suite sécurité OWASP — module 9 (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, BOB, CARLA]);
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

  // ── 1. Injection SQL ──────────────────────────────────────────────────────

  describe('1. Injection SQL', () => {
    it.each([
      "30j' OR '1'='1",
      "'; DROP TABLE audit_log; --",
      "' UNION SELECT actor_name FROM audit_log --",
      "30j'; UPDATE audit_log SET actor_id = NULL; --",
    ])('REFUSE « %s » comme période plutôt que de l’interpoler', async charge => {
      // La période est une énumération fermée : rien de ce qu'envoie
      // l'appelant n'atteint la requête.
      const admin = await session(ADMIN);
      await lire(`/usage?periode=${encodeURIComponent(charge)}`, admin).expect(400);

      // Le journal est INTACT — et c'est vérifiable, puisque la connexion
      // d'admin vient d'y écrire.
      expect(t.db.auditLog.some(e => e['actorId'] === ID_ADMIN)).toBe(true);
    });
  });

  // ── 5. Contrôle d'accès ───────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it('FERME par défaut : aucune route n’est publique', async () => {
      await http.get(t.url('/usage')).expect(401);
      await http.get(t.url('/usage/gouvernance')).expect(401);
    });

    it('REFUSE les deux lectures sans usage:read', async () => {
      // Le registre de traitement dit ce que l'application conserve : cela ne
      // regarde pas tous les comptes.
      const bob = await session(BOB);
      await lire('/usage', bob).expect(403);
      await lire('/usage/gouvernance', bob).expect(403);
    });

    it('n’expose AUCUNE écriture, y compris sur des chemins devinés', async () => {
      const admin = await session(ADMIN);
      const chemins = ['/usage', '/usage/gouvernance', '/usage/anonymiser', '/usage/purge'];

      for (const chemin of chemins) {
        for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
          await http[methode](t.url(chemin))
            .set('Cookie', admin.cookies)
            .set('X-CSRF-Token', admin.csrf)
            .expect(404);
        }
      }
    });

    it('ne laisse PAS déclencher l’anonymisation depuis l’extérieur', async () => {
      // C'est la seule opération capable de modifier le journal d'audit : la
      // seule façon de la lancer doit rester le minuteur.
      const admin = await session(ADMIN);
      const avant = t.db.auditLog.length;

      await http
        .post(t.url('/usage/anonymiser'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .expect(404);

      expect(t.db.auditLog).toHaveLength(avant);
      expect(t.db.auditLog.every(e => e['actorName'] !== null)).toBe(true);
    });
  });

  // ── 7. Réidentification et données sensibles ──────────────────────────────

  describe('7. Données sensibles — le risque propre à ce module', () => {
    it('ne rend AUCUN nom, identifiant ni adresse IP', async () => {
      await session(BOB);
      await session(CARLA);
      const admin = await session(ADMIN);

      const corps = JSON.stringify((await lire('/usage', admin).expect(200)).body);

      for (const trace of ['bob', 'carla', 'admin', ID_BOB, ID_CARLA, ID_ADMIN]) {
        expect(corps).not.toContain(trace);
      }
      expect(corps).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    });

    it('ne rend AUCUNE identité dans le registre de traitement', async () => {
      // Le registre NOMME les colonnes personnelles ; il n'en montre pas le
      // contenu.
      await session(BOB);
      const admin = await session(ADMIN);

      const corps = JSON.stringify((await lire('/usage/gouvernance', admin).expect(200)).body);

      expect(corps).toContain('adresse IP');
      expect(corps).not.toContain('bob');
      expect(corps).not.toContain(ID_BOB);
    });

    it('ne laisse PAS réduire la fenêtre jusqu’à désigner quelqu’un', async () => {
      // Sept jours au plus court : sur une journée, puis une heure, un
      // compteur dans une équipe de dix ne compte plus, il désigne.
      const admin = await session(ADMIN);

      for (const periode of ['1j', '1h', '0j', '-7j']) {
        await lire(`/usage?periode=${encodeURIComponent(periode)}`, admin).expect(400);
      }
      await lire('/usage?periode=7j', admin).expect(200);
    });

    it('REFUSE un paramètre de requête inconnu', async () => {
      // `?acteur=bob` sur un module d'agrégats serait une tentative de
      // ventilation nominative.
      const admin = await session(ADMIN);

      await lire('/usage?acteur=bob', admin).expect(400);
      await lire('/usage?periode=30j&groupBy=actor_id', admin).expect(400);
    });

    it('rend une erreur UNIFORME, sans trace d’exécution', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage?periode=inconnue', admin).expect(400);

      expect(res.body).toHaveProperty('requestId');
      expect(JSON.stringify(res.body)).not.toContain('at ');
      expect(JSON.stringify(res.body)).not.toContain('node_modules');
      expect(JSON.stringify(res.body)).not.toContain('audit_log');
    });
  });

  // ── 12. Limitation de débit ───────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('PLAFONNE la lecture des agrégats', async () => {
      // Chaque appel déclenche sept agrégations : sans borne, la route est un
      // levier d'épuisement à moindres frais.
      const admin = await session(ADMIN);

      let refuse = false;
      for (let i = 0; i < 40 && !refuse; i += 1) {
        const res = await lire('/usage', admin);
        refuse = res.status === 429;
      }

      expect(refuse).toBe(true);
    });
  });

  // ── Permission, pas rang ──────────────────────────────────────────────────

  describe('permission, pas rang', () => {
    it('ouvre à un rang INFÉRIEUR qui porte usage:read', async () => {
      t.db.permissions.set(ID_CARLA, [{ permission: PERMISSIONS.USAGE_READ, gammes: null }]);
      const carla = await session(CARLA);

      await lire('/usage', carla).expect(200);
    });
  });
});
