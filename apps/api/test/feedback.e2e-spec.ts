import { RANKS } from '@websentry/shared';
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
const BOB = {
  id: ID_BOB,
  username: 'bob',
  password: 'MotDePasseBob!2026',
  rank: RANKS.TESTER,
};
const CARLA = {
  id: ID_CARLA,
  username: 'carla',
  password: 'MotDePasseCarla!2026',
  rank: RANKS.TESTER,
};

const RETOUR = {
  kind: 'bug',
  severity: 'majeur',
  title: 'Le score ne se recalcule pas',
  body: 'Après avoir changé la pondération, le score affiché reste celui d’avant.',
};

describe('Retours des bêta-testeurs (E2E)', () => {
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

  function write(
    method: 'post' | 'patch',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  /** Dépose un retour et rend son identifiant. */
  async function deposer(auth: { cookies: string[]; csrf: string }, over = {}) {
    const res = await write('post', '/feedback', auth)
      .send({ ...RETOUR, ...over })
      .expect(201);
    return res.body.id as string;
  }

  describe('accès', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/feedback')).expect(401);
      await http.post(t.url('/feedback')).send(RETOUR).expect(401);
    });

    it('OUVRE le dépôt à un testeur, sans permission particulière', async () => {
      // Si signaler coûte une permission à demander, personne ne signale.
      const bob = await session(BOB);
      const res = await write('post', '/feedback', bob).send(RETOUR).expect(201);

      expect(res.body).toMatchObject({ status: 'nouveau', authorName: 'bob' });
    });

    it('refuse une écriture sans jeton CSRF', async () => {
      const bob = await session(BOB);
      await http.post(t.url('/feedback')).set('Cookie', bob.cookies).send(RETOUR).expect(403);
    });
  });

  describe('visibilité', () => {
    it('ne montre à un testeur QUE ses propres retours', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(bob, { title: 'Retour de Bob, bien à lui' });
      await deposer(carla, { title: 'Retour de Carla, bien à elle' });

      const res = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0].authorName).toBe('bob');
      expect(JSON.stringify(res.body)).not.toContain('Carla');
    });

    it('ne laisse PAS contourner la restriction par un paramètre d’URL', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(carla);

      const res = await http
        .get(t.url('/feedback?mine=false'))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(res.body.total).toBe(0);
    });

    it('répond 404 — et NON 403 — sur le retour d’un autre', async () => {
      // Un 403 confirmerait qu'un retour existe sous cet identifiant.
      const bob = await session(BOB);
      const carla = await session(CARLA);
      const id = await deposer(carla);

      await http
        .get(t.url(`/feedback/${id}`))
        .set('Cookie', bob.cookies)
        .expect(404);
    });

    it('MONTRE tout à qui détient feedback:read', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(bob);
      await deposer(carla);

      const admin = await session(ADMIN);
      const res = await http.get(t.url('/feedback')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.total).toBe(2);
    });

    it('laisse un trieur demander SES seuls retours', async () => {
      const bob = await session(BOB);
      await deposer(bob);
      const admin = await session(ADMIN);
      await deposer(admin, { title: 'Retour déposé par l’administrateur' });

      const res = await http
        .get(t.url('/feedback?mine=true'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0].authorName).toBe('admin');
    });

    it('restreint AUSSI les compteurs', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(bob);
      await deposer(carla);

      const compteursBob = await http
        .get(t.url('/feedback/compteurs'))
        .set('Cookie', bob.cookies)
        .expect(200);
      const compteursAdmin = await http
        .get(t.url('/feedback/compteurs'))
        .set('Cookie', (await session(ADMIN)).cookies)
        .expect(200);

      expect(compteursBob.body.nouveau).toBe(1);
      expect(compteursAdmin.body.nouveau).toBe(2);
      // Tous les statuts sont présents, zéros compris.
      expect(Object.keys(compteursBob.body).sort()).toEqual([
        'accepte',
        'en_cours',
        'nouveau',
        'rejete',
        'resolu',
      ]);
    });
  });

  describe('validation du dépôt', () => {
    it('REFUSE un titre ou un corps trop courts', async () => {
      const bob = await session(BOB);
      await write('post', '/feedback', bob)
        .send({ ...RETOUR, title: 'bug' })
        .expect(400);
      await write('post', '/feedback', bob)
        .send({ ...RETOUR, body: 'ko' })
        .expect(400);
    });

    it('REFUSE de poser le statut au dépôt — pas d’affectation de masse', async () => {
      const bob = await session(BOB);
      await write('post', '/feedback', bob)
        .send({ ...RETOUR, status: 'resolu' })
        .expect(400);
    });

    it('capture le contexte sans le redemander', async () => {
      const bob = await session(BOB);
      const res = await write('post', '/feedback', bob)
        .send({ ...RETOUR, context: { route: '/profils/premium', gamme: 'premium' } })
        .expect(201);

      expect(res.body.context).toEqual({
        route: '/profils/premium',
        targetUrl: null,
        gamme: 'premium',
      });
    });
  });

  describe('triage', () => {
    it('REFUSE le triage à un testeur, même sur SON retour', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);

      await write('patch', `/feedback/${id}`, bob).send({ status: 'resolu' }).expect(403);
    });

    it('suit le chemin des statuts, étape par étape', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      // Sauter directement à « résolu » est refusé : le chemin raconte ce qui
      // s'est passé.
      await write('patch', `/feedback/${id}`, admin).send({ status: 'resolu' }).expect(400);

      await write('patch', `/feedback/${id}`, admin).send({ status: 'accepte' }).expect(200);
      await write('patch', `/feedback/${id}`, admin).send({ status: 'en_cours' }).expect(200);
      const resolu = await write('patch', `/feedback/${id}`, admin)
        .send({ status: 'resolu', resolution: 'Corrigé en 2.0.1.' })
        .expect(200);

      expect(resolu.body.status).toBe('resolu');
      expect(resolu.body.resolvedAt).not.toBeNull();
      expect(resolu.body.resolution).toBe('Corrigé en 2.0.1.');
    });

    it('EFFACE la date de résolution quand le retour est rouvert', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      for (const status of ['accepte', 'en_cours', 'resolu']) {
        await write('patch', `/feedback/${id}`, admin).send({ status }).expect(200);
      }
      const rouvert = await write('patch', `/feedback/${id}`, admin)
        .send({ status: 'en_cours' })
        .expect(200);

      expect(rouvert.body.resolvedAt).toBeNull();
    });

    it('n’expose NI le titre NI le corps au triage', async () => {
      // Ils appartiennent à l'auteur.
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await write('patch', `/feedback/${id}`, admin).send({ title: 'Réécrit' }).expect(400);
      await write('patch', `/feedback/${id}`, admin).send({ body: 'Réécrit' }).expect(400);
    });

    it('REFUSE une demande de triage vide', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await write('patch', `/feedback/${id}`, admin).send({}).expect(400);
    });

    it('assigne puis désassigne, en ramenant le nom', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      const assigne = await write('patch', `/feedback/${id}`, admin)
        .send({ assignedTo: ID_ADMIN })
        .expect(200);
      expect(assigne.body.assignedName).toBe('admin');

      const libere = await write('patch', `/feedback/${id}`, admin)
        .send({ assignedTo: null })
        .expect(200);
      expect(libere.body.assignedTo).toBeNull();
      expect(libere.body.assignedName).toBeNull();
    });

    it('répond 400 sur un identifiant qui n’est pas un UUID', async () => {
      const admin = await session(ADMIN);
      await write('patch', '/feedback/pas-un-uuid', admin).send({ status: 'accepte' }).expect(400);
    });
  });

  describe('journal d’audit', () => {
    it('trace le dépôt et le triage SANS recopier le corps', async () => {
      // Le corps peut citer des URL clientes ; le journal se lit plus largement
      // que la table des retours.
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);
      await write('patch', `/feedback/${id}`, admin).send({ status: 'accepte' }).expect(200);

      const actions = t.db.auditLog.map(e => e['action']);
      expect(actions).toContain('feedback.create');
      expect(actions).toContain('feedback.triage');
      expect(JSON.stringify(t.db.auditLog)).not.toContain('pondération');
    });
  });

  describe('bornes de lecture', () => {
    it('REFUSE une limite hors bornes', async () => {
      const bob = await session(BOB);
      await http.get(t.url('/feedback?limit=500')).set('Cookie', bob.cookies).expect(400);
    });

    it('REFUSE un paramètre inconnu', async () => {
      const bob = await session(BOB);
      await http.get(t.url('/feedback?tri=date')).set('Cookie', bob.cookies).expect(400);
    });

    it('annonce le total AVANT pagination', async () => {
      const bob = await session(BOB);
      for (let i = 0; i < 3; i += 1) await deposer(bob, { title: `Retour numéro ${i} de Bob` });

      const res = await http.get(t.url('/feedback?limit=1')).set('Cookie', bob.cookies).expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(3);
    });

    it('filtre par type, gravité et recherche', async () => {
      const bob = await session(BOB);
      await deposer(bob, { kind: 'suggestion', title: 'Ajouter un export CSV du rapport' });
      await deposer(bob, { kind: 'bug', title: 'Le score ne se recalcule pas' });

      const parType = await http
        .get(t.url('/feedback?kind=suggestion'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(parType.body.total).toBe(1);

      const parRecherche = await http
        .get(t.url('/feedback?search=export'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(parRecherche.body.total).toBe(1);
    });
  });

  describe('surface exposée', () => {
    it('ne laisse fuir AUCUN champ hors du contrat', async () => {
      const bob = await session(BOB);
      await deposer(bob);
      const res = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);

      expect(Object.keys(res.body.items[0]).sort()).toEqual([
        'assignedName',
        'assignedTo',
        'authorId',
        'authorName',
        'body',
        'context',
        'createdAt',
        'id',
        'kind',
        'resolution',
        'resolvedAt',
        'severity',
        'status',
        'title',
        'updatedAt',
      ]);
    });

    it('ne propose NI suppression NI réécriture', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await http
        .delete(t.url(`/feedback/${id}`))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .expect(404);
      await http
        .put(t.url(`/feedback/${id}`))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .expect(404);
    });
  });
});
