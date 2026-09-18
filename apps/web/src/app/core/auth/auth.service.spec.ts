import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { PERMISSIONS, RANKS, type CurrentUser } from '@websentry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { AuthService } from './auth.service';

const BASE = '/api/v1';

/**
 * Laisse s'exécuter les microtâches en attente.
 *
 * Après un `flush`, la suite de la chaîne de promesses — et donc la requête
 * suivante — n'est émise qu'au tour de boucle d'après : sans cette attente,
 * `expectOne` chercherait une requête pas encore partie.
 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function profile(over: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    username: 'alice',
    rank: RANKS.TESTER,
    role: 'tester',
    status: 'active',
    permissions: [],
    ...over,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        AuthService,
      ],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  describe('état initial', () => {
    it('démarre sans utilisateur et en chargement', () => {
      expect(service.user()).toBeNull();
      expect(service.loading()).toBe(true);
      expect(service.isAuthenticated()).toBe(false);
    });
  });

  describe('refreshProfile', () => {
    it('pose le profil renvoyé par l’API', async () => {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile({ rank: RANKS.ADMIN, role: 'admin' }));

      await promise;
      expect(service.user()?.username).toBe('alice');
      expect(service.isAuthenticated()).toBe(true);
      expect(service.loading()).toBe(false);
    });

    it('traite un 401 comme une absence de session, pas comme une erreur', async () => {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(null, { status: 401, statusText: 'Unauthorized' });

      await expect(promise).resolves.toBeNull();
      expect(service.user()).toBeNull();
      expect(service.error()).toBeNull();
    });

    it('REJETTE une réponse qui ne respecte pas le schéma partagé', async () => {
      // Une API qui dérive est détectée ici, pas trois écrans plus loin.
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush({ username: 'alice' }); // champs manquants

      await expect(promise).resolves.toBeNull();
      expect(service.user()).toBeNull();
    });

    it('retire l’état de chargement même en cas d’échec', async () => {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(null, { status: 500, statusText: 'Erreur' });
      await promise;
      expect(service.loading()).toBe(false);
    });
  });

  describe('login', () => {
    it('ouvre la session puis recharge le profil', async () => {
      const promise = service.login('alice', 'mdp');

      const loginReq = http.expectOne(`${BASE}/auth/login`);
      expect(loginReq.request.method).toBe('POST');
      expect(loginReq.request.body).toEqual({ username: 'alice', password: 'mdp' });
      loginReq.flush({ role: 'tester', username: 'alice' });
      await tick();

      http.expectOne(`${BASE}/auth/me`).flush(profile());

      await expect(promise).resolves.toEqual({ role: 'tester', username: 'alice' });
      expect(service.isAuthenticated()).toBe(true);
    });

    it('expose un message d’erreur exploitable sur échec', async () => {
      const promise = service.login('alice', 'mauvais');
      http
        .expectOne(`${BASE}/auth/login`)
        .flush(
          { statusCode: 401, error: 'Unauthorized', message: 'Identifiants incorrects' },
          { status: 401, statusText: 'Unauthorized' },
        );

      await expect(promise).rejects.toBeDefined();
      expect(service.error()).toBe('Identifiants incorrects');
      expect(service.isAuthenticated()).toBe(false);
    });

    it('retombe sur un message générique quand l’API n’en fournit pas', async () => {
      const promise = service.login('alice', 'mdp');
      http.expectOne(`${BASE}/auth/login`).flush(null, { status: 0, statusText: 'Réseau' });

      await expect(promise).rejects.toBeDefined();
      expect(service.error()).toBe('Connexion impossible — réessayez');
    });
  });

  describe('logout', () => {
    it('vide l’état local après appel réussi', async () => {
      const setup = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile());
      await setup;

      const promise = service.logout();
      http.expectOne(`${BASE}/auth/logout`).flush(null, { status: 204, statusText: 'No Content' });
      await promise;

      expect(service.user()).toBeNull();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('vide l’état local MÊME si l’appel échoue', async () => {
      // Laisser l'interface croire à une session ouverte serait plus trompeur
      // qu'utile.
      const setup = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile());
      await setup;

      const promise = service.logout();
      http.expectOne(`${BASE}/auth/logout`).flush(null, { status: 500, statusText: 'Erreur' });
      await promise.catch(() => undefined);

      expect(service.user()).toBeNull();
    });
  });

  describe('refreshSession', () => {
    it('retourne true quand la rotation réussit', async () => {
      const promise = service.refreshSession();
      http.expectOne(`${BASE}/auth/refresh`).flush({ role: 'tester', username: 'alice' });
      await expect(promise).resolves.toBe(true);
    });

    it('retourne false et vide la session quand la rotation échoue', async () => {
      const promise = service.refreshSession();
      http
        .expectOne(`${BASE}/auth/refresh`)
        .flush(null, { status: 401, statusText: 'Unauthorized' });
      await expect(promise).resolves.toBe(false);
      expect(service.user()).toBeNull();
    });
  });

  describe('dérivations de rang', () => {
    async function withRank(rank: number, permissions: CurrentUser['permissions'] = []) {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile({ rank, permissions }));
      await promise;
    }

    it('dérive le rôle depuis le rang', async () => {
      await withRank(RANKS.ADMIN);
      expect(service.role()).toBe('admin');
      expect(service.isAdmin()).toBe(true);
      expect(service.isSuperAdmin()).toBe(false);
    });

    it('reconnaît le super_admin', async () => {
      await withRank(RANKS.SUPER_ADMIN);
      expect(service.role()).toBe('super_admin');
      expect(service.isSuperAdmin()).toBe(true);
    });

    it('n’accorde pas les droits admin à un editor', async () => {
      await withRank(RANKS.EDITOR);
      expect(service.role()).toBe('editor');
      expect(service.isAdmin()).toBe(false);
    });

    it('retourne un rôle nul sans session', () => {
      expect(service.role()).toBeNull();
      expect(service.rank()).toBe(0);
    });
  });

  describe('hasPermission', () => {
    async function withRank(rank: number, permissions: CurrentUser['permissions'] = []) {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile({ rank, permissions }));
      await promise;
    }

    it('refuse tout sans session', () => {
      expect(service.hasPermission(PERMISSIONS.DOCS_READ)).toBe(false);
    });

    it('accorde TOUT au super_admin, sans grant explicite', async () => {
      // Même règle que `RbacService.resolve` côté serveur : l'interface n'affiche
      // jamais une action que l'API refuserait.
      await withRank(RANKS.SUPER_ADMIN);
      expect(service.hasPermission(PERMISSIONS.AUDIT_READ)).toBe(true);
      expect(service.hasPermission(PERMISSIONS.USERS_DELETE)).toBe(true);
    });

    it('accorde une permission explicitement détenue', async () => {
      await withRank(RANKS.EDITOR, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]);
      expect(service.hasPermission(PERMISSIONS.DOCS_READ)).toBe(true);
    });

    it('refuse une permission non détenue', async () => {
      await withRank(RANKS.EDITOR, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]);
      expect(service.hasPermission(PERMISSIONS.USERS_DELETE)).toBe(false);
    });
  });

  describe('gammeInScope', () => {
    async function withPermissions(rank: number, permissions: CurrentUser['permissions']) {
      const promise = service.refreshProfile();
      http.expectOne(`${BASE}/auth/me`).flush(profile({ rank, permissions }));
      await promise;
    }

    it('autorise quand aucune gamme n’est demandée', async () => {
      await withPermissions(RANKS.EDITOR, []);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, null)).toBe(true);
    });

    it('refuse sans session', () => {
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'premium')).toBe(false);
    });

    it('autorise tout au super_admin', async () => {
      await withPermissions(RANKS.SUPER_ADMIN, []);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'premium')).toBe(true);
    });

    it('autorise une gamme du scope, sans distinction de casse', async () => {
      await withPermissions(RANKS.EDITOR, [
        { permission: PERMISSIONS.DOCS_READ, gammes: ['Premium'] },
      ]);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'premium')).toBe(true);
    });

    it('refuse une gamme hors scope', async () => {
      await withPermissions(RANKS.EDITOR, [
        { permission: PERMISSIONS.DOCS_READ, gammes: ['premium'] },
      ]);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'essentiel')).toBe(false);
    });

    it('autorise toutes les gammes quand le scope est ouvert', async () => {
      await withPermissions(RANKS.EDITOR, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'nimporte')).toBe(true);
    });

    it('refuse quand la permission elle-même n’est pas détenue', async () => {
      await withPermissions(RANKS.EDITOR, []);
      expect(service.gammeInScope(PERMISSIONS.DOCS_READ, 'premium')).toBe(false);
    });
  });
});
