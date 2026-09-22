import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

/**
 * Routes d'administration des comptes, bout en bout.
 *
 * Les identifiants sont de vrais UUID : la route les valide comme tels, et un
 * identifiant fantaisiste serait rejeté avant d'atteindre le service — ce qui
 * masquerait ce que ces tests veulent prouver.
 */
const ID_SUPER = '11111111-1111-4111-8111-111111111111';
const ID_ADMIN = '22222222-2222-4222-8222-222222222222';
const ID_ADMIN_2 = '33333333-3333-4333-8333-333333333333';
const ID_TESTEUR = '44444444-4444-4444-8444-444444444444';
const ID_INCONNU = '99999999-9999-4999-8999-999999999999';

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
const ADMIN_2 = {
  id: ID_ADMIN_2,
  username: 'adminbis',
  password: 'MotDePasseAdminBis!2026',
  rank: RANKS.ADMIN,
};
/** Même rang qu'`admin`, mais porteur explicite de `users:delete`. */
const ADMIN_ARME = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'adminarme',
  password: 'MotDePasseAdminArme!2026',
  rank: RANKS.ADMIN,
  permissions: [{ permission: PERMISSIONS.USERS_DELETE, gammes: null }],
};

const TESTEUR = {
  id: ID_TESTEUR,
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

const TOUS = [SUPER, ADMIN, ADMIN_2, ADMIN_ARME, TESTEUR];

describe('Gestion des comptes (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp(TOUS);
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

  // ── Accès ────────────────────────────────────────────────────────────────

  describe('accès aux routes', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/users')).expect(401);
    });

    it('refuse un TESTEUR, qui ne porte pas users:read', async () => {
      const testeur = await session(TESTEUR);
      await http.get(t.url('/users')).set('Cookie', testeur.cookies).expect(403);
    });

    it('refuse une écriture sans jeton CSRF', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/users'))
        .set('Cookie', admin.cookies)
        .send({ username: 'nouveau', password: 'MotDePasseValide!2026', rank: RANKS.TESTER })
        .expect(403);
    });

    it('sert la liste à un administrateur', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.total).toBe(TOUS.length);
      expect(res.body.users).toHaveLength(TOUS.length);
    });
  });

  // ── Fuite de données ─────────────────────────────────────────────────────

  describe('surface exposée', () => {
    it('n’expose JAMAIS l’empreinte ni les compteurs d’échec', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);

      // On inspecte la charge utile SÉRIALISÉE : une propriété ajoutée par
      // mégarde au DTO se verrait ici et nulle part ailleurs.
      const brut = JSON.stringify(res.body);
      for (const interdit of ['password_hash', 'passwordHash', 'token_version', 'failed_logins']) {
        expect(brut).not.toContain(interdit);
      }
    });

    it('trie par rang décroissant puis par identifiant', async () => {
      const admin = await session(ADMIN);
      const res = await http.get(t.url('/users')).set('Cookie', admin.cookies).expect(200);

      expect(res.body.users.map((u: { username: string }) => u.username)).toEqual([
        'patron',
        'admin',
        'adminarme',
        'adminbis',
        'testeur',
      ]);
    });

    it('filtre et pagine, en annonçant le total NON paginé', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url(`/users?rank=${RANKS.ADMIN}&limit=1&offset=1`))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.total).toBe(3);
      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].username).toBe('adminarme');
    });

    it('cherche sur le nom et le courriel', async () => {
      const admin = await session(ADMIN);
      const res = await http
        .get(t.url('/users?search=adminbis'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body.users).toHaveLength(1);
    });

    it('refuse une limite hors bornes', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/users?limit=5000')).set('Cookie', admin.cookies).expect(400);
    });

    it('répond 400 sur un identifiant qui n’est pas un UUID', async () => {
      const admin = await session(ADMIN);
      await http.get(t.url('/users/pas-un-uuid')).set('Cookie', admin.cookies).expect(400);
    });

    it('répond 404 sur un compte inexistant', async () => {
      const admin = await session(ADMIN);
      await http
        .get(t.url(`/users/${ID_INCONNU}`))
        .set('Cookie', admin.cookies)
        .expect(404);
    });
  });

  // ── Élévation de privilège ───────────────────────────────────────────────

  describe('élévation de privilège', () => {
    it('REFUSE de créer un compte au-dessus de son propre rang', async () => {
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

    it('REFUSE de s’élever soi-même', async () => {
      const admin = await session(ADMIN);
      await write('patch', `/users/${ID_ADMIN}`, admin)
        .send({ rank: RANKS.SUPER_ADMIN })
        .expect(403);

      expect(t.db.users.get(ID_ADMIN)?.rank).toBe(RANKS.ADMIN);
    });

    it('REFUSE de suspendre un compte de rang supérieur', async () => {
      const admin = await session(ADMIN);
      await write('patch', `/users/${ID_SUPER}`, admin).send({ status: 'suspended' }).expect(403);

      expect(t.db.users.get(ID_SUPER)?.status).toBe('active');
    });

    it('REFUSE de changer le mot de passe d’un compte de rang supérieur', async () => {
      const admin = await session(ADMIN);
      const avant = t.db.users.get(ID_SUPER)?.password_hash;

      await write('post', `/users/${ID_SUPER}/password`, admin)
        .send({ password: 'MotDePasseVole!2026' })
        .expect(403);

      expect(t.db.users.get(ID_SUPER)?.password_hash).toBe(avant);
    });

    it('REFUSE la suppression à un administrateur, qui ne porte pas users:delete', async () => {
      const admin = await session(ADMIN);
      await write('delete', `/users/${ID_TESTEUR}`, admin).expect(403);

      expect(t.db.users.has(ID_TESTEUR)).toBe(true);
    });

    it('REFUSE de supprimer un pair de même rang MALGRÉ users:delete accordé', async () => {
      // La permission fine ouvre la route ; elle n'efface pas le garde-fou de
      // rang, qui dépend de la CIBLE et qu'aucune garde de route ne voit.
      const arme = await session(ADMIN_ARME);
      await write('delete', `/users/${ID_ADMIN}`, arme).expect(403);

      expect(t.db.users.has(ID_ADMIN)).toBe(true);
    });

    it('REFUSE de déléguer une permission qu’on ne détient pas soi-même', async () => {
      // `admin` ne porte pas audit:read — ce code est réservé au rang 100. Le
      // déléguer reviendrait à s'accorder par personne interposée ce que son
      // propre rang lui refuse.
      const admin = await session(ADMIN);
      await write('put', `/users/${ID_TESTEUR}/permissions`, admin)
        .send({ permission: PERMISSIONS.AUDIT_READ, gammes: null })
        .expect(403);
    });

    it('laisse le super_admin déléguer ce qu’il veut', async () => {
      const patron = await session(SUPER);
      await write('put', `/users/${ID_TESTEUR}/permissions`, patron)
        .send({ permission: PERMISSIONS.AUDIT_READ, gammes: null })
        .expect(204);

      const res = await http
        .get(t.url(`/users/${ID_TESTEUR}/permissions`))
        .set('Cookie', patron.cookies)
        .expect(200);
      expect(res.body.map((p: { permission: string }) => p.permission)).toContain(
        PERMISSIONS.AUDIT_READ,
      );
    });
  });

  // ── Anti-verrouillage ────────────────────────────────────────────────────

  describe('dernier administrateur', () => {
    it('REFUSE de suspendre le dernier compte d’administration actif', async () => {
      const patron = await session(SUPER);
      // On retire d'abord les autres : il ne reste que le super_admin lui-même.
      await write('delete', `/users/${ID_ADMIN}`, patron).expect(204);
      await write('delete', `/users/${ID_ADMIN_2}`, patron).expect(204);
      await write('delete', `/users/${ADMIN_ARME.id}`, patron).expect(204);

      // Un second super_admin pour agir sur le premier sans buter sur le
      // garde-fou de l'auto-modification.
      await write('post', '/users', patron)
        .send({
          username: 'second',
          password: 'MotDePasseSecond!2026',
          rank: RANKS.SUPER_ADMIN,
        })
        .expect(201);
      const second = t.db.byUsername('second')!;

      await write('delete', `/users/${second.id}`, patron).expect(204);
      await write('patch', `/users/${ID_SUPER}`, patron).send({ status: 'suspended' }).expect(403);
    });
  });

  // ── Cycle de vie complet ─────────────────────────────────────────────────

  describe('cycle de vie d’un compte', () => {
    it('crée un compte qui peut ensuite se connecter', async () => {
      const admin = await session(ADMIN);
      const res = await write('post', '/users', admin)
        .send({
          username: 'Nouvelle.Recrue',
          password: 'MotDePasseRecrue!2026',
          rank: RANKS.TESTER,
          displayName: 'Nouvelle Recrue',
        })
        .expect(201);

      // L'identifiant est NORMALISÉ par le schéma partagé : la connexion doit
      // fonctionner avec la forme normalisée, et le compte ne doit exister
      // qu'une fois.
      expect(res.body.username).toBe('nouvelle.recrue');
      expect(res.body.role).toBe('tester');
      await session({ username: 'nouvelle.recrue', password: 'MotDePasseRecrue!2026' });
    });

    it('REFUSE un identifiant déjà pris, quelle que soit la casse', async () => {
      const admin = await session(ADMIN);
      await write('post', '/users', admin)
        .send({ username: 'TESTEUR', password: 'MotDePasseValide!2026', rank: RANKS.TESTER })
        .expect(409);
    });

    it('REFUSE un mot de passe trop court', async () => {
      const admin = await session(ADMIN);
      await write('post', '/users', admin)
        .send({ username: 'faible', password: 'court', rank: RANKS.TESTER })
        .expect(400);
    });

    it('REFUSE une clé surnuméraire — pas d’affectation de masse', async () => {
      const admin = await session(ADMIN);
      await write('post', '/users', admin)
        .send({
          username: 'malin',
          password: 'MotDePasseValide!2026',
          rank: RANKS.TESTER,
          status: 'active',
          tokenVersion: 99,
        })
        .expect(400);
    });

    it('met à jour sans toucher aux champs absents', async () => {
      const admin = await session(ADMIN);
      const res = await write('patch', `/users/${ID_TESTEUR}`, admin)
        .send({ displayName: 'Testeur Renommé' })
        .expect(200);

      expect(res.body.displayName).toBe('Testeur Renommé');
      expect(res.body.email).toBe('testeur@exemple.fr');
      expect(res.body.rank).toBe(RANKS.TESTER);
    });

    it('REFUSE une mise à jour vide', async () => {
      const admin = await session(ADMIN);
      await write('patch', `/users/${ID_TESTEUR}`, admin).send({}).expect(400);
    });

    it('suspend un compte et invalide sa session EN COURS', async () => {
      const testeur = await session(TESTEUR);
      await http.get(t.url('/auth/me')).set('Cookie', testeur.cookies).expect(200);

      const admin = await session(ADMIN);
      await write('patch', `/users/${ID_TESTEUR}`, admin).send({ status: 'suspended' }).expect(200);

      // Le jeton d'accès du testeur portait l'ancienne version : la suspension
      // doit valoir tout de suite, sans attendre son expiration.
      await http.get(t.url('/auth/me')).set('Cookie', testeur.cookies).expect(401);
    });

    it('réinitialise un mot de passe : l’ancien ne vaut plus, le nouveau vaut', async () => {
      const admin = await session(ADMIN);
      await write('post', `/users/${ID_TESTEUR}/password`, admin)
        .send({ password: 'NouveauMotDePasse!2026' })
        .expect(204);

      await http
        .post(t.url('/auth/login'))
        .send({ username: TESTEUR.username, password: TESTEUR.password })
        .expect(401);
      await session({ username: TESTEUR.username, password: 'NouveauMotDePasse!2026' });
    });

    it('supprime un compte, et sa session avec lui', async () => {
      const testeur = await session(TESTEUR);
      const patron = await session(SUPER);

      await write('delete', `/users/${ID_TESTEUR}`, patron).expect(204);

      expect(t.db.users.has(ID_TESTEUR)).toBe(false);
      await http.get(t.url('/auth/me')).set('Cookie', testeur.cookies).expect(401);
    });
  });

  // ── Permissions fines ────────────────────────────────────────────────────

  describe('permissions fines', () => {
    it('accorde, liste puis révoque', async () => {
      const admin = await session(ADMIN);
      await write('put', `/users/${ID_TESTEUR}/permissions`, admin)
        .send({ permission: PERMISSIONS.SCAN_RUN, gammes: ['sante'] })
        .expect(204);

      const res = await http
        .get(t.url(`/users/${ID_TESTEUR}/permissions`))
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(res.body).toContainEqual(
        expect.objectContaining({ permission: PERMISSIONS.SCAN_RUN, gammes: ['sante'] }),
      );

      await write(
        'delete',
        `/users/${ID_TESTEUR}/permissions/${PERMISSIONS.SCAN_RUN}`,
        admin,
      ).expect(204);
      await write(
        'delete',
        `/users/${ID_TESTEUR}/permissions/${PERMISSIONS.SCAN_RUN}`,
        admin,
      ).expect(404);
    });

    it('REFUSE un code de permission inventé', async () => {
      const admin = await session(ADMIN);
      await write('put', `/users/${ID_TESTEUR}/permissions`, admin)
        .send({ permission: 'tout:pouvoir', gammes: null })
        .expect(400);
    });

    it('REFUSE une liste de gammes vide — null veut dire « toutes »', async () => {
      const admin = await session(ADMIN);
      await write('put', `/users/${ID_TESTEUR}/permissions`, admin)
        .send({ permission: PERMISSIONS.SCAN_RUN, gammes: [] })
        .expect(400);
    });
  });

  // ── Journal d'audit ──────────────────────────────────────────────────────

  describe('journal d’audit', () => {
    it('trace chaque écriture SANS jamais y écrire le mot de passe', async () => {
      const admin = await session(ADMIN);
      const motDePasse = 'MotDePasseTraçable!2026';

      await write('post', '/users', admin)
        .send({ username: 'tracee', password: motDePasse, rank: RANKS.TESTER })
        .expect(201);
      const creee = t.db.byUsername('tracee')!;
      await write('post', `/users/${creee.id}/password`, admin)
        .send({ password: 'AutreMotDePasse!2026' })
        .expect(204);

      const actions = t.db.auditLog.map(e => e['action']);
      expect(actions).toContain('user.create');
      expect(actions).toContain('user.password_reset');

      // Aucune VALEUR de mot de passe, et aucune CLÉ qui en porterait une —
      // le nom d'action `user.password_reset`, lui, est légitime.
      const details = JSON.stringify(t.db.auditLog.map(e => e['details']));
      expect(details).not.toContain(motDePasse);
      expect(details).not.toContain('AutreMotDePasse!2026');
      expect(details).not.toMatch(/password|motdepasse|hash/i);
    });
  });
});
