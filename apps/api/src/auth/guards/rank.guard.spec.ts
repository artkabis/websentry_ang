import { ForbiddenException } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { RANKS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { mockExecutionContext } from '../../testing/execution-context.mock.js';
import { RankGuard } from './rank.guard.js';

function buildGuard(minRank: number | undefined): RankGuard {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(minRank) } as unknown as Reflector;
  return new RankGuard(reflector);
}

describe('RankGuard', () => {
  it('laisse passer une route SANS seuil déclaré', () => {
    // Sans @MinRank(), l'accès a déjà été tranché par la garde d'authentification.
    const guard = buildGuard(undefined);
    expect(guard.canActivate(mockExecutionContext({ authUser: undefined }))).toBe(true);
  });

  it('laisse passer un contexte non HTTP', () => {
    const guard = buildGuard(RANKS.ADMIN);
    expect(guard.canActivate(mockExecutionContext({}, 'ws'))).toBe(true);
  });

  it('autorise un rang strictement supérieur au seuil', () => {
    const guard = buildGuard(RANKS.ADMIN);
    const ctx = mockExecutionContext({
      authUser: { sub: 'u1', username: 'root', rank: RANKS.SUPER_ADMIN, version: 0 },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('autorise un rang ÉGAL au seuil', () => {
    const guard = buildGuard(RANKS.ADMIN);
    const ctx = mockExecutionContext({
      authUser: { sub: 'u1', username: 'admin', rank: RANKS.ADMIN, version: 0 },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('refuse un rang inférieur au seuil', () => {
    const guard = buildGuard(RANKS.ADMIN);
    const ctx = mockExecutionContext({
      authUser: { sub: 'u1', username: 'bob', rank: RANKS.EDITOR, version: 0 },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('refuse un editor sur une route super_admin — pas d’élévation par saut de palier', () => {
    const guard = buildGuard(RANKS.SUPER_ADMIN);
    const ctx = mockExecutionContext({
      authUser: { sub: 'u1', username: 'bob', rank: RANKS.ADMIN, version: 0 },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('traite une requête sans identité comme un rang 0', () => {
    const guard = buildGuard(RANKS.TESTER);
    expect(() => guard.canActivate(mockExecutionContext({ authUser: undefined }))).toThrow(
      ForbiddenException,
    );
  });
});
