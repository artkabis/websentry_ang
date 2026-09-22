import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const TESTEUR = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

describe('Supervision (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, TESTEUR]);
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
      await http.get(t.url('/supervision')).expect(401);
    });

    it('refuse un testeur, qui ne porte pas health:read', async () => {
      const testeur = await session(TESTEUR);
      await http.get(t.url('/supervision')).set('Cookie', testeur.cookies).expect(403);
    });

    it('sert le relevé à un administrateur', async () => {
      // C'est une donnée d'exploitation : qui pilote l'outil doit pouvoir
      // constater une panne sans attendre le rang le plus élevé.
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);

      // La suite tourne avec SCAN_RETENTION_ENABLED=false : le relevé annonce
      // donc « dégradé », et c'est EXACTEMENT ce qu'on attend de lui — une
      // rétention éteinte laisse les rapports s'accumuler sans le dire.
      expect(res.body.etat).toBe('degrade');
      expect(res.body.retention).toMatchObject({ etat: 'degrade', active: false });
      expect(res.body.base.etat).toBe('ok');
      expect(res.body.poolAnalyse.etat).toBe('ok');
    });
  });

  describe('la sonde PUBLIQUE reste pauvre', () => {
    it('ne dit rien de l’infrastructure', async () => {
      // Une sonde bavarde est un outil de reconnaissance offert gratuitement
      // (OWASP #7).
      const res = await http.get(t.url('/health')).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['ok', 'version']);
      const brut = JSON.stringify(res.body);
      for (const interdit of ['base', 'latence', 'pool', 'retention', 'uptime', 'environnement']) {
        expect(brut).not.toContain(interdit);
      }
    });
  });

  describe('contenu du relevé', () => {
    it('décrit les trois composants et l’instance', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);

      expect(Object.keys(res.body).sort()).toEqual([
        'base',
        'etat',
        'instance',
        'poolAnalyse',
        'releveA',
        'retention',
        'volumetrie',
      ]);
      expect(res.body.instance).toMatchObject({ version: '2.0.0' });
    });

    it('compte les comptes actifs et les retours ouverts', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/feedback'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .send({
          kind: 'bug',
          severity: 'majeur',
          title: 'Un retour à compter',
          body: 'Une description suffisamment longue pour passer.',
        })
        .expect(201);

      const res = await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);
      expect(res.body.volumetrie).toMatchObject({ comptesActifs: 2, retoursOuverts: 1 });
    });

    it('n’expose NI nom d’hôte NI chaîne de connexion', async () => {
      // Le relevé décrit des ÉTATS, pas la topologie.
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/supervision')).set('Cookie', admin.cookies).expect(200);

      const brut = JSON.stringify(res.body);
      for (const interdit of ['localhost', '3306', 'password', 'mysql', 'ECONNREFUSED']) {
        expect(brut.toLowerCase()).not.toContain(interdit.toLowerCase());
      }
    });
  });

  describe('lecture seule', () => {
    it('n’offre AUCUNE commande d’exploitation', async () => {
      // Redémarrer un pool ou forcer une purge depuis une page web serait une
      // surface d'attaque pour un gain nul.
      const admin = await session(ADMIN);
      for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
        await http[methode](t.url('/supervision'))
          .set('Cookie', admin.cookies)
          .set('X-CSRF-Token', admin.csrf)
          .expect(404);
      }
    });
  });
});
