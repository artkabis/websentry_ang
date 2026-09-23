import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité OWASP — module 6 (retours des bêta-testeurs).
 *
 * Ce module a une particularité qui mérite son propre examen : c'est le SEUL
 * dont les routes ne portent aucune garde de permission. Le dépôt est ouvert à
 * tout compte authentifié — délibérément — et la restriction de visibilité vit
 * dans le service, sur le filtre SQL. Une suite qui se contenterait de
 * constater l'absence de décorateur passerait à côté de l'essentiel.
 *
 * S'y ajoute une surface rare dans le projet : du TEXTE LIBRE fourni par
 * l'utilisateur, stocké puis restitué.
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
  rank: RANKS.TESTER,
};

const RETOUR = {
  kind: 'bug',
  severity: 'majeur',
  title: 'Le score ne se recalcule pas',
  body: 'Après avoir changé la pondération, le score affiché reste celui d’avant.',
};

const INJECTIONS = [
  "' OR '1'='1",
  "'; DROP TABLE feedback; --",
  "' UNION SELECT password_hash FROM users --",
  "\\' OR 1=1 #",
];

describe('Suite sécurité OWASP — module 6 (E2E)', () => {
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
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  async function deposer(auth: { cookies: string[]; csrf: string }, over = {}) {
    const res = await write('post', '/feedback', auth)
      .send({ ...RETOUR, ...over })
      .expect(201);
    return res.body.id as string;
  }

  // ── 1. Injection SQL ──────────────────────────────────────────────────────

  describe('1. Injection SQL', () => {
    it.each(INJECTIONS)('neutralise « %s » dans la recherche', async charge => {
      const bob = await session(BOB);
      await deposer(bob);

      const res = await http
        .get(t.url(`/feedback?search=${encodeURIComponent(charge)}`))
        .set('Cookie', bob.cookies)
        .expect(200);

      // Si la charge était interpolée, « OR '1'='1 » rendrait tout.
      expect(res.body.total).toBe(0);
    });

    it('laisse les retours INTACTS après les charges destructrices', async () => {
      const bob = await session(BOB);
      await deposer(bob);

      for (const charge of INJECTIONS) {
        await http
          .get(t.url(`/feedback?search=${encodeURIComponent(charge)}`))
          .set('Cookie', bob.cookies);
      }

      const apres = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);
      expect(apres.body.total).toBe(1);
    });

    it('stocke une charge d’injection comme du TEXTE, sans l’exécuter', async () => {
      // Le corps d'un retour est du texte libre : il DOIT pouvoir contenir une
      // charge, et ressortir tel quel.
      const bob = await session(BOB);
      await deposer(bob, { body: "'; DROP TABLE feedback; -- et le reste du signalement." });

      const res = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);
      expect(res.body.items[0].body).toContain('DROP TABLE feedback');
      expect(res.body.total).toBe(1);
    });

    it('REFUSE un statut ou un type hors catalogue plutôt que de l’interpoler', async () => {
      const bob = await session(BOB);
      await http.get(t.url("/feedback?status=nouveau'--")).set('Cookie', bob.cookies).expect(400);
      await http.get(t.url('/feedback?kind=doleance')).set('Cookie', bob.cookies).expect(400);
    });
  });

  // ── 5. Contrôle d'accès ───────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it('FERME par défaut, malgré l’absence de garde de permission', async () => {
      await http.get(t.url('/feedback')).expect(401);
      await http.get(t.url('/feedback/compteurs')).expect(401);
      await http.post(t.url('/feedback')).send(RETOUR).expect(401);
    });

    it('CLOISONNE la lecture sans feedback:read', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(bob, { title: 'Retour de Bob, bien à lui' });
      await deposer(carla, { title: 'Retour de Carla, bien à elle' });

      const vueBob = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);
      expect(vueBob.body.total).toBe(1);
      expect(JSON.stringify(vueBob.body)).not.toContain('Carla');
    });

    it('ne laisse PAS contourner le cloisonnement par un paramètre d’URL', async () => {
      // La restriction est posée sur le FILTRE SQL, pas après coup : ajouter
      // `mine=false` ne doit rien ouvrir.
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(carla);

      const res = await http
        .get(t.url('/feedback?mine=false'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(res.body.total).toBe(0);
    });

    it('IDOR : le retour d’autrui rend 404, INDISCERNABLE d’un retour absent', async () => {
      // Un 403 confirmerait qu'un retour existe sous cet identifiant.
      const bob = await session(BOB);
      const carla = await session(CARLA);
      const idCarla = await deposer(carla);

      const autrui = await http.get(t.url(`/feedback/${idCarla}`)).set('Cookie', bob.cookies);
      const absent = await http
        .get(t.url('/feedback/99999999-9999-4999-8999-999999999999'))
        .set('Cookie', bob.cookies);

      expect(autrui.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(autrui.body.message).toBe(absent.body.message);
    });

    it('CLOISONNE aussi les compteurs', async () => {
      const bob = await session(BOB);
      const carla = await session(CARLA);
      await deposer(bob);
      await deposer(carla);

      const res = await http
        .get(t.url('/feedback/compteurs'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(res.body.nouveau).toBe(1);
    });

    it('REFUSE le triage à qui n’a pas feedback:read, même sur SON retour', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);

      await write('patch', `/feedback/${id}`, bob).send({ status: 'resolu' }).expect(403);
      expect(t.db.feedback.get(id)?.['status']).toBe('nouveau');
    });

    it('n’expose NI suppression NI réécriture', async () => {
      // Le corps appartient à son auteur ; l'effacer perdrait le signalement.
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await write('delete', `/feedback/${id}`, admin).expect(404);
      await write('put', `/feedback/${id}`, admin).expect(404);
      expect(t.db.feedback.has(id)).toBe(true);
    });
  });

  // ── 2. XSS ────────────────────────────────────────────────────────────────

  describe('2. XSS stocké', () => {
    it('restitue une charge HTML en JSON NON interprétable', async () => {
      // Le corps est du texte libre : la charge doit ressortir intacte, mais
      // servie comme donnée, jamais comme document.
      const bob = await session(BOB);
      await deposer(bob, { body: '<script>alert(1)</script> et la suite du signalement.' });

      const res = await http.get(t.url('/feedback')).set('Cookie', bob.cookies).expect(200);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.items[0].body).toContain('<script>');
    });

    it('n’ÉCHOUE PAS en renvoyant la charge dans un message d’erreur', async () => {
      const bob = await session(BOB);
      const res = await write('post', '/feedback', bob)
        .send({ ...RETOUR, title: '<img src=x onerror=alert(1)>' })
        .expect(201);

      // Titre accepté comme texte ; s'il avait été refusé, le message ne
      // devrait pas le recopier.
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // ── 3. CSRF ───────────────────────────────────────────────────────────────

  describe('3. CSRF', () => {
    it('refuse un dépôt par cookie sans jeton', async () => {
      const bob = await session(BOB);
      await http.post(t.url('/feedback')).set('Cookie', bob.cookies).send(RETOUR).expect(403);
      expect(t.db.feedback.size).toBe(0);
    });

    it('refuse un triage sur jeton DIVERGENT', async () => {
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await http
        .patch(t.url(`/feedback/${id}`))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', 'jeton-fabrique')
        .send({ status: 'accepte' })
        .expect(403);

      expect(t.db.feedback.get(id)?.['status']).toBe('nouveau');
    });
  });

  // ── 15. Mass assignment ───────────────────────────────────────────────────

  describe('15. Mass assignment et validation d’entrée', () => {
    it.each([
      ['status', { status: 'resolu' }],
      ['authorId', { authorId: ID_ADMIN }],
      ['authorName', { authorName: 'admin' }],
      ['assignedTo', { assignedTo: ID_ADMIN }],
      ['resolution', { resolution: 'Déjà corrigé' }],
      ['id', { id: '99999999-9999-4999-8999-999999999999' }],
    ])('REJETTE la clé surnuméraire %s au dépôt', async (_nom, surplus) => {
      const bob = await session(BOB);
      await write('post', '/feedback', bob)
        .send({ ...RETOUR, ...surplus })
        .expect(400);

      expect(t.db.feedback.size).toBe(0);
    });

    it('n’expose NI titre NI corps au triage', async () => {
      // Ils appartiennent à l'auteur : les réécrire effacerait ce qu'il a
      // réellement signalé.
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await write('patch', `/feedback/${id}`, admin).send({ title: 'Réécrit' }).expect(400);
      await write('patch', `/feedback/${id}`, admin).send({ body: 'Réécrit' }).expect(400);
      expect(t.db.feedback.get(id)?.['title']).toBe(RETOUR.title);
    });

    it('BORNE le corps — au-delà, ce n’est plus un retour', async () => {
      const bob = await session(BOB);
      await write('post', '/feedback', bob)
        .send({ ...RETOUR, body: 'x'.repeat(5001) })
        .expect(400);
    });

    it('BORNE la pagination et refuse un paramètre inconnu', async () => {
      const bob = await session(BOB);
      await http.get(t.url('/feedback?limit=5000')).set('Cookie', bob.cookies).expect(400);
      await http.get(t.url('/feedback?offset=-1')).set('Cookie', bob.cookies).expect(400);
      await http.get(t.url('/feedback?tri=date')).set('Cookie', bob.cookies).expect(400);
    });

    it('REFUSE une transition de statut illégale', async () => {
      // Le chemin parcouru raconte ce qui s'est passé.
      const bob = await session(BOB);
      const id = await deposer(bob);
      const admin = await session(ADMIN);

      await write('patch', `/feedback/${id}`, admin).send({ status: 'resolu' }).expect(400);
      expect(t.db.feedback.get(id)?.['status']).toBe('nouveau');
    });
  });

  // ── 9. Pollution de prototype ─────────────────────────────────────────────

  describe('9. Pollution de prototype', () => {
    it.each(['__proto__', 'constructor', 'prototype'])(
      'NEUTRALISE la clé %s soumise dans le contexte',
      async cle => {
        const bob = await session(BOB);
        const corps = JSON.stringify({
          ...RETOUR,
          context: { route: '/analyse', [cle]: { pollue: true } },
        });

        await write('post', '/feedback', bob).type('application/json').send(corps);

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
    ])('REFUSE « %s » comme identifiant de retour', async chemin => {
      const bob = await session(BOB);
      const res = await http.get(t.url(`/feedback/${chemin}`)).set('Cookie', bob.cookies);

      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });
  });

  // ── 7. Données sensibles et messages d'erreur ─────────────────────────────

  describe('7. Données sensibles et messages d’erreur', () => {
    it('n’expose AUCUN champ hors du contrat', async () => {
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

    it('ne recopie PAS le corps du retour dans le journal d’audit', async () => {
      // Le corps peut citer des URL clientes ; le journal se lit plus
      // largement que la table des retours.
      const bob = await session(BOB);
      await deposer(bob, { body: 'Le client https://client-confidentiel.fr plante à l’étape 3.' });

      expect(JSON.stringify(t.db.auditLog)).not.toContain('client-confidentiel');
    });

    it('rend une erreur UNIFORME, sans trace d’exécution', async () => {
      const bob = await session(BOB);
      const res = await http
        .get(t.url('/feedback/pas-un-uuid'))
        .set('Cookie', bob.cookies)
        .expect(400);

      expect(res.body).toHaveProperty('statusCode');
      const brut = JSON.stringify(res.body);
      expect(brut).not.toContain('at ');
      expect(brut).not.toMatch(/\.ts:\d+/);
      expect(brut).not.toContain('node_modules');
    });
  });

  // ── 12. Limitation de débit ───────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('plafonne le dépôt — le seul point d’écriture ouvert à tous', async () => {
      // C'est la surface la plus exposée du projet : ouverte à tout compte
      // authentifié, et stockée telle quelle. Sans borne, un script remplirait
      // la table.
      const bob = await session(BOB);
      const statuts: number[] = [];

      for (let i = 0; i < 14; i++) {
        const res = await write('post', '/feedback', bob).send({
          ...RETOUR,
          title: `Retour en rafale numéro ${i}`,
        });
        statuts.push(res.status);
      }

      expect(statuts).toContain(429);
    });
  });
});
