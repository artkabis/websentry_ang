import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

/**
 * Corbeille des scans, par HTTP réel.
 *
 * Ce que les tests unitaires ne prouvent pas : que les routes sont ATTEINTES —
 * `GET /scans/:pageId` accepterait « corbeille » comme identifiant de page —,
 * que la permission est bien celle de la suppression, et qu'un aller-retour
 * complet passe par l'API et non par les objets internes.
 */

const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const EDITOR = {
  id: 'u-editor',
  username: 'editeur',
  password: 'MotDePasseEdit!2026',
  rank: RANKS.EDITOR,
};

const SITE = '44444444-4444-4444-8444-444444444444';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PAGE = '33333333-3333-4333-8333-333333333333';
const INCONNU = '99999999-9999-4999-8999-999999999999';

describe('Corbeille des scans (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, EDITOR]);
    http = request(t.app.getHttpServer());
    seed();
  });

  afterEach(async () => {
    await t.close();
  });

  function seed(): void {
    t.db.scanSites.set(SITE, {
      id: SITE,
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: 'ABC-123',
      metadata: null,
      last_seen: '2026-06-10 10:00:00',
    });
    t.db.scanSessions.set(SESSION, {
      id: SESSION,
      site_id: SITE,
      gamme: 'premium',
      epj: 'ABC-123',
      platform: 'duda',
      page_count: 1,
      avg_score: 4,
      min_score: 4,
      max_score: 4,
      analyzed_at: '2026-06-01 10:00:00',
      duration_ms: 1000,
      launched_by: 'admin',
      profile_snapshot: null,
    });
    t.db.scanPages.set(PAGE, {
      id: PAGE,
      session_id: SESSION,
      url: 'https://exemple.fr/',
      domain: 'exemple.fr',
      global_score: 4,
      status_code: 200,
      analyzed_at: '2026-06-01 10:00:00',
      duration_ms: 500,
      check_summary: {},
      report: '{"a":1}',
      report_gz: null,
      is_compressed: 0,
      report_purged_at: null,
    });
  }

  async function session(compte: { username: string; password: string }) {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: compte.username, password: compte.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, csrf: cookieValue(cookies, COOKIES.CSRF)! };
  }

  function write(
    method: 'post' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  describe('résolution des routes', () => {
    it('ATTEINT la corbeille, et non la route par identifiant de page', async () => {
      // `GET /scans/:pageId` validerait « corbeille » contre un UUID et
      // répondrait 400. C'est l'ordre de déclaration des contrôleurs qui décide.
      const admin = await session(ADMIN);

      const reponse = await http
        .get(t.url('/scans/corbeille'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(reponse.body).toEqual({ items: [], total: 0 });
    });

    it('REFUSE un identifiant qui n’est pas un UUID', async () => {
      const admin = await session(ADMIN);

      await write('post', '/scans/corbeille/pas-un-uuid/restauration', admin).expect(400);
    });
  });

  describe('accès', () => {
    it('exige `history:delete` — un éditeur est refusé', async () => {
      // L'éditeur a `history:read` mais pas `history:delete` : il ne doit pas
      // voir ce que d'autres ont supprimé, ni le remettre en place.
      const editeur = await session(EDITOR);

      await http.get(t.url('/scans/corbeille')).set('Cookie', editeur.cookies).expect(403);
    });

    it('refuse un visiteur non authentifié', async () => {
      await http.get(t.url('/scans/corbeille')).expect(401);
    });
  });

  describe('aller-retour complet par l’API', () => {
    it('SUPPRIME un site, le retrouve en corbeille, puis le RESTAURE', async () => {
      const admin = await session(ADMIN);

      await write('delete', '/scans/sites', admin)
        .send({ domain: 'exemple.fr', gamme: 'premium' })
        .expect(200);

      // L'historique est vide…
      expect(t.db.scanSites.size).toBe(0);

      // …et la corbeille porte l'entrée, avec ce qu'elle contient.
      const liste = await http
        .get(t.url('/scans/corbeille'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(liste.body.total).toBe(1);
      const entree = liste.body.items[0];
      expect(entree.label).toBe('exemple.fr — premium');
      expect(entree.scope).toBe('site');
      expect(entree.sessionCount).toBe(1);
      expect(entree.pageCount).toBe(1);
      expect(entree.deletedByName).toBe('admin');

      const bilan = await write('post', `/scans/corbeille/${entree.id}/restauration`, admin).expect(
        200,
      );

      expect(bilan.body).toEqual({ sites: 1, sessions: 1, pages: 1, skippedSessions: 0 });
      expect(t.db.scanSites.has(SITE)).toBe(true);
      expect(t.db.scanPages.has(PAGE)).toBe(true);
      // L'entrée a quitté la corbeille : ce qui y reste est ce qui peut encore
      // être restauré.
      const apres = await http
        .get(t.url('/scans/corbeille'))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(apres.body.total).toBe(0);
    });

    it('EXPORTE un instantané versionné', async () => {
      const admin = await session(ADMIN);
      await write('delete', `/scans/sessions/${SESSION}`, admin).expect(200);

      const liste = await http
        .get(t.url('/scans/corbeille'))
        .set('Cookie', admin.cookies)
        .expect(200);
      const id = liste.body.items[0].id;

      const exporte = await http
        .get(t.url(`/scans/corbeille/${id}/export`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(exporte.body.format).toBe(1);
      expect(exporte.body.scope).toBe('session');
      expect(exporte.body.pages).toHaveLength(1);
      // Aucun chemin serveur, aucun nom de table interne dans la réponse.
      expect(JSON.stringify(exporte.body)).not.toMatch(/\/home\/|\/usr\/|node_modules/);
    });

    it('rend 404 sur une entrée inconnue, sans révéler autre chose', async () => {
      const admin = await session(ADMIN);

      const reponse = await http
        .get(t.url(`/scans/corbeille/${INCONNU}/export`))
        .set('Cookie', admin.cookies)
        .expect(404);

      expect(JSON.stringify(reponse.body)).not.toMatch(/scan_trash|SELECT|payload_gz/i);
    });
  });
});
