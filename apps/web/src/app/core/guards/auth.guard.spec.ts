import { TestBed } from '@angular/core/testing';
import {
  Router,
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  type RouterStateSnapshot,
} from '@angular/router';
import { PERMISSIONS, RANKS, type CurrentUser } from '@websentry/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import {
  adminGuard,
  authGuard,
  editorGuard,
  guestGuard,
  permissionGuard,
  superAdminGuard,
} from './auth.guard';

/** Double d'AuthService : les gardes n'en consultent que l'état résolu. */
function authStub(user: CurrentUser | null, loading = false) {
  const refreshProfile = vi.fn().mockResolvedValue(user);
  return {
    user: () => user,
    loading: () => loading,
    isAuthenticated: () => user !== null,
    rank: () => user?.rank ?? 0,
    hasPermission: (code: string) =>
      user !== null &&
      (user.rank >= RANKS.SUPER_ADMIN || user.permissions.some(p => p.permission === code)),
    refreshProfile,
  };
}

function profile(rank: number, permissions: CurrentUser['permissions'] = []): CurrentUser {
  return {
    id: 'u1',
    username: 'alice',
    rank,
    role: 'tester',
    status: 'active',
    permissions,
  };
}

/**
 * Exécute une garde dans un contexte d'injection, comme le ferait le routeur.
 *
 * Le résultat est élargi à `unknown` : selon le cas, une garde rend `true` ou un
 * `UrlTree`, que les tests inspectent ensuite en le typant explicitement.
 */
function run(guard: CanActivateFn, url = '/tableau-de-bord'): Promise<unknown> {
  return Promise.resolve(
    TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    ) as unknown,
  );
}

function setup(user: CurrentUser | null, loading = false) {
  const auth = authStub(user, loading);
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: auth },
      {
        provide: Router,
        useValue: {
          createUrlTree: (commands: unknown[], extras?: unknown) => ({ commands, extras }),
        },
      },
    ],
  });
  return auth;
}

describe('authGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('laisse passer un utilisateur authentifié', async () => {
    setup(profile(RANKS.TESTER));
    await expect(run(authGuard)).resolves.toBe(true);
  });

  it('redirige vers la connexion sans session', async () => {
    setup(null);
    const result = (await run(authGuard, '/tableau-de-bord')) as {
      commands: string[];
      extras: { queryParams: { retour: string } };
    };

    expect(result.commands).toEqual(['/connexion']);
    // `retour` ramène l'utilisateur là où la garde l'a intercepté.
    expect(result.extras.queryParams.retour).toBe('/tableau-de-bord');
  });

  it('résout le profil quand il ne l’est pas encore', async () => {
    // Le cookie est httpOnly : le front ne peut pas savoir s'il est connecté
    // sans interroger l'API.
    const auth = setup(null, true);
    await run(authGuard);
    expect(auth.refreshProfile).toHaveBeenCalled();
  });

  it('ne recharge PAS le profil quand il est déjà résolu', async () => {
    const auth = setup(profile(RANKS.TESTER), false);
    await run(authGuard);
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });
});

describe('rankGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('laisse passer un rang égal au seuil', async () => {
    setup(profile(RANKS.ADMIN));
    await expect(run(adminGuard)).resolves.toBe(true);
  });

  it('laisse passer un rang supérieur au seuil', async () => {
    setup(profile(RANKS.SUPER_ADMIN));
    await expect(run(adminGuard)).resolves.toBe(true);
  });

  it('redirige vers l’accès refusé pour un rang insuffisant', async () => {
    setup(profile(RANKS.EDITOR));
    const result = (await run(adminGuard)) as { commands: string[] };
    expect(result.commands).toEqual(['/acces-refuse']);
  });

  it('redirige vers la connexion sans session', async () => {
    setup(null);
    const result = (await run(adminGuard)) as { commands: string[] };
    expect(result.commands).toEqual(['/connexion']);
  });

  it('refuse un admin sur une route super_admin', async () => {
    setup(profile(RANKS.ADMIN));
    const result = (await run(superAdminGuard)) as { commands: string[] };
    expect(result.commands).toEqual(['/acces-refuse']);
  });

  it('laisse passer un editor sur une route editor', async () => {
    setup(profile(RANKS.EDITOR));
    await expect(run(editorGuard)).resolves.toBe(true);
  });
});

describe('permissionGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('laisse passer avec la permission requise', async () => {
    setup(profile(RANKS.EDITOR, [{ permission: PERMISSIONS.DOCS_READ, gammes: null }]));
    await expect(run(permissionGuard(PERMISSIONS.DOCS_READ))).resolves.toBe(true);
  });

  it('refuse sans la permission requise', async () => {
    setup(profile(RANKS.EDITOR, []));
    const result = (await run(permissionGuard(PERMISSIONS.DOCS_READ))) as { commands: string[] };
    expect(result.commands).toEqual(['/acces-refuse']);
  });

  it('laisse toujours passer le super_admin', async () => {
    setup(profile(RANKS.SUPER_ADMIN, []));
    await expect(run(permissionGuard(PERMISSIONS.AUDIT_READ))).resolves.toBe(true);
  });

  it('redirige vers la connexion sans session', async () => {
    setup(null);
    const result = (await run(permissionGuard(PERMISSIONS.DOCS_READ))) as { commands: string[] };
    expect(result.commands).toEqual(['/connexion']);
  });
});

describe('guestGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('laisse passer un visiteur non authentifié', async () => {
    setup(null);
    await expect(run(guestGuard)).resolves.toBe(true);
  });

  it('renvoie au tableau de bord un utilisateur déjà connecté', async () => {
    setup(profile(RANKS.TESTER));
    const result = (await run(guestGuard)) as { commands: string[] };
    expect(result.commands).toEqual(['/tableau-de-bord']);
  });
});
