import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, RANKS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../audit/audit.service.js';
import type { RbacService } from '../../rbac/rbac.service.js';
import { mockExecutionContext, requestOf } from '../../testing/execution-context.mock.js';
import { PermissionsGuard } from './permissions.guard.js';

function build(opts: {
  code?: string;
  resolve?: ReturnType<typeof vi.fn>;
}) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.code),
  } as unknown as Reflector;
  const rbac = {
    resolve: opts.resolve ?? vi.fn().mockResolvedValue({ gammes: null }),
  } as unknown as RbacService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { guard: new PermissionsGuard(reflector, rbac, audit), rbac, audit };
}

const ALICE = { sub: 'u1', username: 'alice', rank: RANKS.EDITOR, version: 0 };

describe('PermissionsGuard', () => {
  it('laisse passer une route SANS @RequirePermission()', async () => {
    const resolve = vi.fn();
    const { guard } = build({ code: undefined, resolve });
    await expect(guard.canActivate(mockExecutionContext({ authUser: ALICE }))).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('laisse passer un contexte non HTTP', async () => {
    const { guard } = build({ code: PERMISSIONS.USERS_READ });
    await expect(guard.canActivate(mockExecutionContext({}, 'ws'))).resolves.toBe(true);
  });

  it('refuse quand aucune identité n’est résolue', async () => {
    const { guard } = build({ code: PERMISSIONS.USERS_READ });
    await expect(
      guard.canActivate(mockExecutionContext({ authUser: undefined })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accorde l’accès et dépose le scope dans la requête', async () => {
    const { guard } = build({
      code: PERMISSIONS.USERS_READ,
      resolve: vi.fn().mockResolvedValue({ gammes: ['premium'] }),
    });
    const ctx = mockExecutionContext({ authUser: ALICE });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(requestOf(ctx).authPermission).toEqual({
      permission: PERMISSIONS.USERS_READ,
      gammes: ['premium'],
    });
  });

  it('refuse quand la permission n’est pas accordée', async () => {
    const { guard } = build({
      code: PERMISSIONS.USERS_DELETE,
      resolve: vi.fn().mockResolvedValue(null),
    });
    await expect(guard.canActivate(mockExecutionContext({ authUser: ALICE }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('journalise chaque refus — une tentative d’élévation doit laisser une trace', async () => {
    const { guard, audit } = build({
      code: PERMISSIONS.USERS_DELETE,
      resolve: vi.fn().mockResolvedValue(null),
    });
    const ctx = mockExecutionContext({
      authUser: ALICE,
      method: 'DELETE',
      url: '/api/v1/users/u2',
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.permission_denied',
        actorId: 'u1',
        actorName: 'alice',
        details: {
          permission: PERMISSIONS.USERS_DELETE,
          method: 'DELETE',
          url: '/api/v1/users/u2',
        },
      }),
    );
  });

  it('journalise avec une IP nulle quand la requête n’en porte pas', async () => {
    const { guard, audit } = build({
      code: PERMISSIONS.USERS_DELETE,
      resolve: vi.fn().mockResolvedValue(null),
    });

    await expect(
      guard.canActivate(mockExecutionContext({ authUser: ALICE, ip: undefined })),
    ).rejects.toThrow(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: null }));
  });

  it('répond 503 — et NON 403 — quand la base de permissions est injoignable', async () => {
    // Distinguer les deux est important : un 403 laisserait croire à un refus
    // d'autorisation là où il s'agit d'une panne.
    const { guard } = build({
      code: PERMISSIONS.USERS_READ,
      resolve: vi.fn().mockRejectedValue(new Error('connexion perdue')),
    });
    await expect(guard.canActivate(mockExecutionContext({ authUser: ALICE }))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('transmet identifiant ET rang au service de résolution', async () => {
    const resolve = vi.fn().mockResolvedValue({ gammes: null });
    const { guard } = build({ code: PERMISSIONS.DOCS_READ, resolve });

    await guard.canActivate(mockExecutionContext({ authUser: ALICE }));
    expect(resolve).toHaveBeenCalledWith('u1', RANKS.EDITOR, PERMISSIONS.DOCS_READ);
  });
});
