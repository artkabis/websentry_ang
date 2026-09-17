import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { UserRepository, UserRow } from '../../database/repositories/user.repository.js';
import { mockExecutionContext, requestOf } from '../../testing/execution-context.mock.js';
import type { TokenService } from '../token.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const USER = { sub: 'u1', username: 'alice', rank: 50, version: 3 };

/**
 * Surcharges de ligne de test.
 *
 * `RowDataPacket` déclare un membre `constructor` littéral, incompatible avec le
 * `constructor` implicite d'un objet littéral : `Partial<UserRow>` refuserait
 * donc `{ rank: 50 }`. On l'écarte explicitement.
 */
type RowOverrides<T> = Partial<Omit<T, 'constructor'>>;

function userRow(over: RowOverrides<UserRow> = {}): UserRow {
  return {
    id: 'u1',
    username: 'alice',
    password_hash: 'sel:hash',
    display_name: null,
    email: null,
    rank: 50,
    status: 'active',
    token_version: 3,
    failed_logins: 0,
    locked_until: null,
    ...over,
  } as UserRow;
}

function build(opts: {
  isPublic?: boolean;
  verify?: ReturnType<typeof vi.fn>;
  available?: boolean;
  findById?: ReturnType<typeof vi.fn>;
}) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.isPublic ?? false),
  } as unknown as Reflector;
  const tokens = {
    verify: opts.verify ?? vi.fn().mockResolvedValue(null),
  } as unknown as TokenService;
  const users = {
    available: opts.available ?? true,
    findById: opts.findById ?? vi.fn().mockResolvedValue(userRow()),
  } as unknown as UserRepository;
  return { guard: new JwtAuthGuard(reflector, tokens, users), tokens, users };
}

describe('JwtAuthGuard', () => {
  describe('routes ouvertes', () => {
    it('laisse passer une route @Public() sans vérifier de jeton', async () => {
      const verify = vi.fn();
      const { guard } = build({ isPublic: true, verify });
      await expect(guard.canActivate(mockExecutionContext({}))).resolves.toBe(true);
      expect(verify).not.toHaveBeenCalled();
    });

    it('laisse passer un contexte non HTTP', async () => {
      const { guard } = build({});
      await expect(guard.canActivate(mockExecutionContext({}, 'ws'))).resolves.toBe(true);
    });
  });

  describe('résolution du porteur de jeton', () => {
    it('accepte le cookie ws_access et marque authVia=cookie', async () => {
      const verify = vi.fn().mockResolvedValue(USER);
      const { guard } = build({ verify });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'jeton-valide' } });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(requestOf(ctx).authUser).toEqual(USER);
      expect(requestOf(ctx).authVia).toBe('cookie');
    });

    it('accepte l’en-tête Bearer et marque authVia=bearer', async () => {
      const verify = vi.fn().mockResolvedValue(USER);
      const { guard } = build({ verify });
      const ctx = mockExecutionContext({ headers: { authorization: 'Bearer jeton-valide' } });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(requestOf(ctx).authVia).toBe('bearer');
    });

    it('préfère le cookie quand les deux porteurs sont présents', async () => {
      const verify = vi
        .fn()
        .mockResolvedValueOnce(USER) // cookie
        .mockResolvedValueOnce({ ...USER, username: 'bearer-user' });
      const { guard } = build({ verify });
      const ctx = mockExecutionContext({
        cookies: { ws_access: 'jeton-cookie' },
        headers: { authorization: 'Bearer jeton-bearer' },
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(requestOf(ctx).authVia).toBe('cookie');
      expect(requestOf(ctx).authUser?.username).toBe('alice');
    });

    it('se replie sur Bearer quand le cookie est invalide', async () => {
      const verify = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(USER);
      const { guard } = build({ verify });
      const ctx = mockExecutionContext({
        cookies: { ws_access: 'jeton-perime' },
        headers: { authorization: 'Bearer jeton-valide' },
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(requestOf(ctx).authVia).toBe('bearer');
    });

    it.each([
      [{}, {}, 'aucun porteur'],
      [{}, { authorization: 'jeton-sans-prefixe' }, 'en-tête sans le préfixe Bearer'],
      [{}, { authorization: 'Basic dXNlcjpwYXNz' }, 'schéma Basic'],
    ])('refuse : %s / %s (%s)', async (cookies, headers, _label) => {
      const { guard } = build({});
      const ctx = mockExecutionContext({
        cookies: cookies,
        headers: headers,
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse un en-tête Bearer porteur d’un jeton invalide', async () => {
      const verify = vi.fn().mockResolvedValue(null);
      const { guard } = build({ verify });
      const ctx = mockExecutionContext({ headers: { authorization: 'Bearer jeton-forge' } });

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(verify).toHaveBeenCalledWith('jeton-forge');
    });

    it('refuse un jeton que le service rejette', async () => {
      const { guard } = build({ verify: vi.fn().mockResolvedValue(null) });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'jeton-forge' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('révocation par token_version', () => {
    it('accepte quand la version du jeton correspond à celle en base', async () => {
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        findById: vi.fn().mockResolvedValue(userRow({ token_version: 3 })),
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'ok' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('REFUSE quand token_version a été incrémentée — révocation immédiate', async () => {
      // C'est le cœur du mécanisme : un jeton encore dans sa fenêtre de validité
      // doit cesser d'être honoré dès l'incrément côté serveur.
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        findById: vi.fn().mockResolvedValue(userRow({ token_version: 4 })),
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'jeton-revoque' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse un compte supprimé', async () => {
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        findById: vi.fn().mockResolvedValue(null),
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'ok' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it.each(['suspended', 'pending'] as const)('refuse un compte au statut %s', async status => {
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        findById: vi.fn().mockResolvedValue(userRow({ status })),
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'ok' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('n’interroge pas la base quand aucune base n’est configurée', async () => {
      const findById = vi.fn();
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        available: false,
        findById,
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'ok' } });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(findById).not.toHaveBeenCalled();
    });

    it('REFUSE quand la base est injoignable — une panne ne doit pas contourner la révocation', async () => {
      // Le repli permissif de la v1 rendait la révocation contournable en faisant
      // tomber la base. Ici, la panne dégrade la disponibilité, pas l'autorisation.
      const { guard } = build({
        verify: vi.fn().mockResolvedValue(USER),
        findById: vi.fn().mockRejectedValue(new Error('connexion perdue')),
      });
      const ctx = mockExecutionContext({ cookies: { ws_access: 'ok' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
