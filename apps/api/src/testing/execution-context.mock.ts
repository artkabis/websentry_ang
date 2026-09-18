import type { ExecutionContext } from '@nestjs/common';
import { vi } from 'vitest';
import type { AuthenticatedRequest } from '../common/types.js';

/**
 * Fabrique un `ExecutionContext` HTTP minimal.
 *
 * Les gardes ne lisent que la requête et les métadonnées du handler : reconstruire
 * un contexte complet n'apporterait rien et masquerait ce que la garde consulte
 * réellement.
 */
export function mockExecutionContext(
  req: Partial<AuthenticatedRequest> = {},
  type: 'http' | 'ws' | 'rpc' = 'http',
): ExecutionContext {
  const request = {
    method: 'GET',
    url: '/api/v1/test',
    headers: {},
    cookies: {},
    ip: '203.0.113.10',
    ...req,
  } as AuthenticatedRequest;

  return {
    getType: () => type,
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => (() => undefined) as T,
    }),
    switchToRpc: vi.fn(),
    switchToWs: vi.fn(),
    getArgs: vi.fn(),
    getArgByIndex: vi.fn(),
  } as unknown as ExecutionContext;
}

/** Récupère la requête portée par un contexte fabriqué ci-dessus. */
export function requestOf(ctx: ExecutionContext): AuthenticatedRequest {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>();
}
