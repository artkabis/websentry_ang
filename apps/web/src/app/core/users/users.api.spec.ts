import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PERMISSIONS, RANKS } from '@websentry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { UsersApi } from './users.api';

const BASE = '/api/v1';
const ID = '22222222-2222-4222-8222-222222222222';

/** Compte minimal conforme au schéma partagé. */
function compte(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    username: 'bob',
    displayName: null,
    email: null,
    rank: RANKS.TESTER,
    role: 'tester',
    status: 'active',
    lockedUntil: null,
    totalScansLaunched: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

describe('UsersApi', () => {
  let api: UsersApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(UsersApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('liste', () => {
    it('n’envoie AUCUN paramètre sans filtre', async () => {
      const promesse = api.list();
      const requete = http.expectOne(`${BASE}/users`);

      expect(requete.request.params.keys()).toEqual([]);
      requete.flush({ users: [], total: 0 });
      await promesse;
    });

    it('OMET les filtres vides plutôt que de les envoyer vides', async () => {
      // Un `status=` vide n'exprime aucun filtre : l'envoyer transformerait
      // « pas de filtre » en « filtre sur la chaîne vide ».
      const promesse = api.list({ search: 'ali', status: '', rank: null, limit: 25, offset: 50 });
      const requete = http.expectOne(r => r.url === `${BASE}/users`);

      expect(requete.request.params.keys().sort()).toEqual(['limit', 'offset', 'search']);
      expect(requete.request.params.get('search')).toBe('ali');
      expect(requete.request.params.get('offset')).toBe('50');
      requete.flush({ users: [], total: 0 });
      await promesse;
    });

    it('envoie un décalage de 0, qui est un filtre légitime', async () => {
      // `0` est falsy : une omission naïve le perdrait et ramènerait la
      // première page au lieu de celle demandée.
      const promesse = api.list({ offset: 0 });
      const requete = http.expectOne(r => r.url === `${BASE}/users`);

      expect(requete.request.params.get('offset')).toBe('0');
      requete.flush({ users: [], total: 0 });
      await promesse;
    });

    it('valide la réponse contre le schéma partagé', async () => {
      const promesse = api.list();
      http.expectOne(`${BASE}/users`).flush({ users: [compte()], total: 1 });

      const recue = await promesse;
      expect(recue.total).toBe(1);
      expect(recue.users[0]?.username).toBe('bob');
    });

    it('REJETTE une réponse qui dérive du schéma', async () => {
      // Ces réponses décrivent des DROITS : un rang manquant ferait afficher
      // un compte pour ce qu'il n'est pas.
      const promesse = api.list();
      http.expectOne(`${BASE}/users`).flush({ users: [{ id: ID, username: 'bob' }], total: 1 });

      await expect(promesse).rejects.toThrow();
    });

    it('REJETTE un compte qui porterait une empreinte de mot de passe', async () => {
      // Le schéma est strict : une clé surnuméraire signale une API qui fuit,
      // et l'interface doit s'en apercevoir à la frontière.
      const promesse = api.list();
      http
        .expectOne(`${BASE}/users`)
        .flush({ users: [{ ...compte(), passwordHash: 'sel:empreinte' }], total: 1 });

      await expect(promesse).rejects.toThrow();
    });
  });

  describe('écritures', () => {
    it('lit un compte', async () => {
      const promesse = api.get(ID);
      const requete = http.expectOne(`${BASE}/users/${ID}`);

      expect(requete.request.method).toBe('GET');
      requete.flush(compte());
      expect((await promesse).id).toBe(ID);
    });

    it('crée un compte', async () => {
      const entree = { username: 'bob', password: 'MotDePasseValide!2026', rank: RANKS.TESTER };
      const promesse = api.create(entree);
      const requete = http.expectOne(`${BASE}/users`);

      expect(requete.request.method).toBe('POST');
      expect(requete.request.body).toEqual(entree);
      requete.flush(compte());
      await promesse;
    });

    it('met à jour par PATCH, et n’envoie QUE ce qui change', async () => {
      const promesse = api.update(ID, { status: 'suspended' });
      const requete = http.expectOne(`${BASE}/users/${ID}`);

      expect(requete.request.method).toBe('PATCH');
      expect(requete.request.body).toEqual({ status: 'suspended' });
      requete.flush(compte({ status: 'suspended' }));
      await promesse;
    });

    it('réinitialise le mot de passe sur une route DISTINCTE', async () => {
      const promesse = api.resetPassword(ID, 'NouveauMotDePasse!2026');
      const requete = http.expectOne(`${BASE}/users/${ID}/password`);

      expect(requete.request.method).toBe('POST');
      expect(requete.request.body).toEqual({ password: 'NouveauMotDePasse!2026' });
      requete.flush(null, { status: 204, statusText: 'No Content' });
      await promesse;
    });

    it('supprime un compte', async () => {
      const promesse = api.remove(ID);
      const requete = http.expectOne(`${BASE}/users/${ID}`);

      expect(requete.request.method).toBe('DELETE');
      requete.flush(null, { status: 204, statusText: 'No Content' });
      await promesse;
    });
  });

  describe('permissions', () => {
    it('lit et valide la liste', async () => {
      const promesse = api.listPermissions(ID);
      http.expectOne(`${BASE}/users/${ID}/permissions`).flush([
        {
          permission: PERMISSIONS.SCAN_RUN,
          gammes: ['sante'],
          grantedBy: null,
          grantedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
      ]);

      expect((await promesse)[0]?.gammes).toEqual(['sante']);
    });

    it('accorde par PUT', async () => {
      const octroi = { permission: PERMISSIONS.SCAN_RUN, gammes: null, expiresAt: null };
      const promesse = api.grantPermission(ID, octroi);
      const requete = http.expectOne(`${BASE}/users/${ID}/permissions`);

      expect(requete.request.method).toBe('PUT');
      expect(requete.request.body).toEqual(octroi);
      requete.flush(null, { status: 204, statusText: 'No Content' });
      await promesse;
    });

    it('ENCODE le code de permission dans le chemin', async () => {
      // `users:read` contient un deux-points : sans encodage, il se retrouve
      // interprété dans le chemin plutôt que transmis tel quel.
      const promesse = api.revokePermission(ID, PERMISSIONS.USERS_READ);
      const requete = http.expectOne(`${BASE}/users/${ID}/permissions/users%3Aread`);

      expect(requete.request.method).toBe('DELETE');
      requete.flush(null, { status: 204, statusText: 'No Content' });
      await promesse;
    });
  });
});
