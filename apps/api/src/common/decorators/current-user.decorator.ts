import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser } from '../types.js';

/**
 * Injecte l'identité résolue par `JwtAuthGuard`.
 *
 * Le type de retour n'est PAS optionnel : ce décorateur ne s'emploie que sur des
 * routes gardées, où l'absence d'utilisateur traduirait une erreur de câblage des
 * gardes — d'où l'exception plutôt qu'un `undefined` propagé silencieusement.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.authUser) {
      throw new Error('@CurrentUser() utilisé sur une route non authentifiée');
    }
    return req.authUser;
  },
);
