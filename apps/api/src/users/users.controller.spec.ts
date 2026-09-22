import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, RANKS } from '@websentry/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { UsersController } from './users.controller.js';
import type { UsersService } from './users.service.js';

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: RANKS.ADMIN, version: 0 };
const ID = '22222222-2222-4222-8222-222222222222';

function req(over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { ip: '203.0.113.10', headers: {}, cookies: {}, ...over } as AuthenticatedRequest;
}

function build() {
  const users = {
    list: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    get: vi.fn().mockResolvedValue({ id: ID }),
    create: vi.fn().mockResolvedValue({ id: ID }),
    update: vi.fn().mockResolvedValue({ id: ID }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    listPermissions: vi.fn().mockResolvedValue([]),
    grantPermission: vi.fn().mockResolvedValue(undefined),
    revokePermission: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new UsersController(users as unknown as UsersService), users };
}

describe('UsersController', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  /**
   * Les permissions sont lues par RÉFLEXION sur les méthodes réelles.
   *
   * C'est le seul moyen de prouver qu'une route n'a pas été ouverte par
   * mégarde : un décorateur oublié ne se voit dans aucun test fonctionnel —
   * la garde laisse simplement passer.
   */
  describe('permissions posées sur les routes', () => {
    const reflector = new Reflector();
    const attendu: Array<[keyof UsersController, string | undefined]> = [
      ['list', PERMISSIONS.USERS_READ],
      ['get', PERMISSIONS.USERS_READ],
      ['listPermissions', PERMISSIONS.USERS_READ],
      ['create', PERMISSIONS.USERS_WRITE],
      ['update', PERMISSIONS.USERS_WRITE],
      ['resetPassword', PERMISSIONS.USERS_WRITE],
      ['grantPermission', PERMISSIONS.USERS_WRITE],
      ['revokePermission', PERMISSIONS.USERS_WRITE],
      ['remove', PERMISSIONS.USERS_DELETE],
    ];

    it.each(attendu)('%s exige %s', (methode, code) => {
      const cible = UsersController.prototype[methode] as unknown as () => void;
      expect(reflector.get(PERMISSIONS_KEY, cible)).toBe(code);
    });

    it('ne laisse AUCUNE route sans permission', () => {
      // On retient les méthodes qui portent un chemin HTTP : un assistant
      // privé n'en a pas, et n'a donc rien à garder.
      const routes = Object.getOwnPropertyNames(UsersController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (UsersController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });
      const gardees = attendu.map(([nom]) => nom as string);

      // Une méthode ajoutée plus tard sans décorateur fait tomber ce test, et
      // c'est le but : la liste ci-dessus doit rester exhaustive.
      expect(routes.sort()).toEqual(gardees.sort());
    });

    it('réserve la suppression à une permission DISTINCTE de l’écriture', () => {
      // Supprimer un compte n'est pas « écrire » : la v1 les confondait, et
      // toute personne pouvant renommer pouvait effacer.
      expect(PERMISSIONS.USERS_DELETE).not.toBe(PERMISSIONS.USERS_WRITE);
    });
  });

  describe('délégation', () => {
    it('transmet la requête de liste telle quelle', async () => {
      await t.controller.list({ limit: 25, offset: 0, search: 'bob' });
      expect(t.users.list).toHaveBeenCalledWith({ limit: 25, offset: 0, search: 'bob' });
    });

    it('transmet l’identifiant en lecture', async () => {
      await t.controller.get(ID);
      expect(t.users.get).toHaveBeenCalledWith(ID);
    });

    it('construit l’acteur à partir du jeton ET de l’IP de la requête', async () => {
      await t.controller.create(
        { username: 'bob', password: 'MotDePasseValide!2026', rank: RANKS.TESTER },
        USER,
        req(),
      );

      expect(t.users.create).toHaveBeenCalledWith(expect.anything(), {
        id: 'u1',
        username: 'alice',
        rank: RANKS.ADMIN,
        ipAddress: '203.0.113.10',
      });
    });

    it('accepte une requête sans IP connue plutôt que d’échouer', async () => {
      // Derrière certains relais, `req.ip` est absent : une trace d'audit sans
      // adresse vaut mieux qu'une écriture refusée.
      await t.controller.create(
        { username: 'bob', password: 'MotDePasseValide!2026', rank: RANKS.TESTER },
        USER,
        req({ ip: undefined }),
      );

      expect(t.users.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('transmet la mise à jour partielle', async () => {
      await t.controller.update(ID, { status: 'suspended' }, USER, req());
      expect(t.users.update).toHaveBeenCalledWith(
        ID,
        { status: 'suspended' },
        expect.objectContaining({ id: 'u1' }),
      );
    });

    it('n’extrait QUE le mot de passe de la charge de réinitialisation', async () => {
      await t.controller.resetPassword(ID, { password: 'NouveauMotDePasse!2026' }, USER, req());
      expect(t.users.resetPassword).toHaveBeenCalledWith(
        ID,
        'NouveauMotDePasse!2026',
        expect.objectContaining({ id: 'u1' }),
      );
    });

    it('transmet la suppression', async () => {
      await t.controller.remove(ID, USER, req());
      expect(t.users.remove).toHaveBeenCalledWith(ID, expect.objectContaining({ id: 'u1' }));
    });

    it('transmet la lecture des permissions', async () => {
      await t.controller.listPermissions(ID);
      expect(t.users.listPermissions).toHaveBeenCalledWith(ID);
    });

    it('transmet l’octroi et la révocation d’une permission', async () => {
      await t.controller.grantPermission(
        ID,
        { permission: PERMISSIONS.SCAN_RUN, gammes: ['sante'], expiresAt: null },
        USER,
        req(),
      );
      expect(t.users.grantPermission).toHaveBeenCalledWith(
        ID,
        { permission: PERMISSIONS.SCAN_RUN, gammes: ['sante'], expiresAt: null },
        expect.objectContaining({ id: 'u1' }),
      );

      await t.controller.revokePermission(ID, PERMISSIONS.SCAN_RUN, USER, req());
      expect(t.users.revokePermission).toHaveBeenCalledWith(
        ID,
        PERMISSIONS.SCAN_RUN,
        expect.objectContaining({ id: 'u1' }),
      );
    });
  });
});
