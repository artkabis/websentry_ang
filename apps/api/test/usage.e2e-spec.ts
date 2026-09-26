import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

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

describe('Analytics d’usage (E2E)', () => {
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

  describe('accès', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/usage')).expect(401);
      await http.get(t.url('/usage/gouvernance')).expect(401);
    });

    it('REFUSE qui ne détient pas usage:read', async () => {
      const bob = await session(BOB);
      await lire('/usage', bob).expect(403);
      await lire('/usage/gouvernance', bob).expect(403);
    });

    it('OUVRE à un administrateur, qui le détient par défaut', async () => {
      const admin = await session(ADMIN);
      await lire('/usage', admin).expect(200);
      await lire('/usage/gouvernance', admin).expect(200);
    });

    it('accorde usage:read à un rang inférieur par permission EXPLICITE', async () => {
      // La garde repose sur la permission, pas sur le rang.
      t.db.permissions.set(ID_CARLA, [{ permission: PERMISSIONS.USAGE_READ, gammes: null }]);
      const carla = await session(CARLA);

      await lire('/usage', carla).expect(200);
    });
  });

  describe('le tunnel compte ce qui s’est RÉELLEMENT passé', () => {
    it('suit les comptes distincts, pas les connexions', async () => {
      // Une personne qui se connecte trois fois ne fait pas trois comptes.
      await session(BOB);
      await session(BOB);
      await session(CARLA);
      const admin = await session(ADMIN);

      const res = await lire('/usage', admin).expect(200);
      const connexion = (
        res.body.tunnel as { cle: string; comptes: number; actions: number }[]
      ).find(e => e.cle === 'connexion')!;

      expect(connexion.comptes).toBe(3);
      expect(connexion.actions).toBe(4);
      expect(res.body.comptesActifs).toBe(3);
    });

    it('rend les TROIS étapes, même vides', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage', admin).expect(200);

      expect((res.body.tunnel as { cle: string }[]).map(e => e.cle)).toEqual([
        'connexion',
        'analyse',
        'exploitation',
      ]);
    });

    it('compte l’EXPLOITATION à partir d’actions réelles', async () => {
      const bob = await session(BOB);
      await http
        .post(t.url('/feedback'))
        .set('Cookie', bob.cookies)
        .set('X-CSRF-Token', bob.csrf)
        .send({
          kind: 'bug',
          severity: 'majeur',
          title: 'Un titre suffisant',
          body: 'Une description suffisamment longue pour passer.',
        })
        .expect(201);

      const admin = await session(ADMIN);
      const res = await lire('/usage', admin).expect(200);
      const exploitation = (res.body.tunnel as { cle: string; comptes: number }[]).find(
        e => e.cle === 'exploitation',
      )!;

      expect(exploitation.comptes).toBe(1);
    });
  });

  describe('série quotidienne', () => {
    it('couvre la fenêtre ENTIÈRE, jours vides compris', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage?periode=7j', admin).expect(200);

      // Huit points : les sept jours écoulés, plus celui en cours.
      expect(res.body.parJour).toHaveLength(8);
      expect(res.body.parJour.at(-1).connexions).toBeGreaterThan(0);
    });

    it('change de longueur avec la période', async () => {
      const admin = await session(ADMIN);
      const trenteJours = await lire('/usage?periode=30j', admin).expect(200);

      expect(trenteJours.body.parJour).toHaveLength(31);
      expect(trenteJours.body.periode).toBe('30j');
    });

    it('retient 30 jours par défaut', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage', admin).expect(200);

      expect(res.body.periode).toBe('30j');
    });

    it('REFUSE une période hors catalogue', async () => {
      // Une plage libre laisserait isoler une heure, et un compteur sur une
      // heure dans une équipe de dix désigne quelqu'un.
      const admin = await session(ADMIN);
      await lire('/usage?periode=1j', admin).expect(400);
      await lire('/usage?periode=2026-01-01..2026-01-02', admin).expect(400);
    });
  });

  describe('gouvernance', () => {
    it('ANNONCE qu’aucune collecte dédiée n’existe', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage/gouvernance', admin).expect(200);

      expect(res.body.collecteDediee).toBe(false);
    });

    it('DÉCRIT les tables, leur finalité et leur conservation', async () => {
      const admin = await session(ADMIN);
      const res = await lire('/usage/gouvernance', admin).expect(200);

      const tables = (res.body.sources as { table: string }[]).map(s => s.table);
      expect(tables).toEqual(['audit_log', 'scan_sessions', 'scan_trash', 'users']);
      expect(res.body.anonymisation.apresJours).toBeGreaterThan(0);
    });

    it('COMPTE ce qui reste identifiant au-delà du délai', async () => {
      // Une entrée ancienne, écrite directement dans le journal du double.
      t.db.auditLog.push({
        actorId: ID_BOB,
        actorName: 'bob',
        action: 'auth.login',
        ipAddress: '203.0.113.1',
        created_at: '2020-01-01T00:00:00.000Z',
      });

      const admin = await session(ADMIN);
      const res = await lire('/usage/gouvernance', admin).expect(200);

      expect(res.body.anonymisation.enAttente).toBe(1);
    });
  });

  describe('ce que le module ne rend JAMAIS', () => {
    it('n’expose AUCUN nom, identifiant ni adresse IP', async () => {
      // La question « qui a fait quoi » se lit dans le journal d'audit,
      // réservé au rang 100 ; « combien de comptes font quoi » se lit ici.
      await session(BOB);
      await session(CARLA);
      const admin = await session(ADMIN);

      const apercu = await lire('/usage', admin).expect(200);
      const corps = JSON.stringify(apercu.body);

      for (const trace of ['bob', 'carla', 'admin', ID_BOB, ID_CARLA, '127.0.0.1', '::ffff:']) {
        expect(corps).not.toContain(trace);
      }
    });

    it('n’offre AUCUNE écriture, pas même un déclenchement', async () => {
      // Ce serait une porte vers la seule opération capable de modifier le
      // journal d'audit.
      const admin = await session(ADMIN);
      for (const chemin of ['/usage', '/usage/gouvernance', '/usage/anonymiser']) {
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
