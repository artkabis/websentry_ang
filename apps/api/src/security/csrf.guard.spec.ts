import { ForbiddenException } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { type AuditService } from '../audit/audit.service.js';
import { mockExecutionContext } from '../testing/execution-context.mock.js';
import { CsrfGuard } from './csrf.guard.js';

const TOKEN = 'jeton-csrf-aleatoire';

function buildGuard(skip = false) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(skip) } as unknown as Reflector;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { guard: new CsrfGuard(reflector, audit), audit };
}

describe('CsrfGuard', () => {
  describe('cas exemptés', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('laisse passer %s — méthode sans effet de bord', method => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({ method, authVia: 'cookie', cookies: {} });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('laisse passer un client Bearer — aucun cookie ambiant, donc aucun vecteur CSRF', () => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({ method: 'POST', authVia: 'bearer', cookies: {} });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('laisse passer une route marquée @SkipCsrf()', () => {
      const { guard } = buildGuard(true);
      const ctx = mockExecutionContext({ method: 'POST', authVia: 'cookie', cookies: {} });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('laisse passer un contexte non HTTP', () => {
      const { guard } = buildGuard();
      expect(guard.canActivate(mockExecutionContext({ method: 'POST' }, 'ws'))).toBe(true);
    });

    it('laisse passer une requête sans authVie cookie (non authentifiée)', () => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({ method: 'POST', authVia: undefined, cookies: {} });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('double-submit sur mutation par cookie', () => {
    it('accepte quand le cookie et l’en-tête coïncident', () => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'POST',
        authVia: 'cookie',
        cookies: { ws_csrf: TOKEN },
        headers: { 'x-csrf-token': TOKEN },
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('accepte un en-tête livré sous forme de tableau', () => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'POST',
        authVia: 'cookie',
        cookies: { ws_csrf: TOKEN },
        headers: { 'x-csrf-token': [TOKEN] as unknown as string },
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it.each([
      [{ ws_csrf: TOKEN }, {}, 'en-tête absent — le cas d’une requête inter-site'],
      [{}, { 'x-csrf-token': TOKEN }, 'cookie absent'],
      [{}, {}, 'ni cookie ni en-tête'],
      [{ ws_csrf: TOKEN }, { 'x-csrf-token': 'autre-valeur' }, 'valeurs divergentes'],
      [{ ws_csrf: '' }, { 'x-csrf-token': '' }, 'deux valeurs vides'],
    ])('refuse : %s / %s (%s)', (cookies, headers, _label) => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'POST',
        authVia: 'cookie',
        cookies: cookies,
        headers: headers,
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('protège la méthode %s', method => {
      const { guard } = buildGuard();
      const ctx = mockExecutionContext({ method, authVia: 'cookie', cookies: {}, headers: {} });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('journalise chaque échec — sans trace, l’abus reste invisible', () => {
      const { guard, audit } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'POST',
        url: '/api/v1/users',
        authVia: 'cookie',
        authUser: { sub: 'u1', username: 'alice', rank: 50, version: 0 },
        cookies: { ws_csrf: TOKEN },
        headers: {},
      });

      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.csrf_failed',
          actorId: 'u1',
          actorName: 'alice',
          details: { method: 'POST', url: '/api/v1/users' },
        }),
      );
    });

    it('journalise avec une IP nulle quand la requête n’en porte pas', () => {
      const { guard, audit } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'POST',
        authVia: 'cookie',
        ip: undefined,
        cookies: {},
        headers: {},
      });

      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: null }));
    });

    it('journalise un échec même sans identité résolue', () => {
      const { guard, audit } = buildGuard();
      const ctx = mockExecutionContext({
        method: 'DELETE',
        authVia: 'cookie',
        authUser: undefined,
        cookies: {},
        headers: {},
      });

      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: null, actorName: 'unknown' }),
      );
    });
  });
});
