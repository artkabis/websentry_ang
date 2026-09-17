import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MIN_RANK_KEY } from '../../common/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../../common/types.js';

/**
 * Seuil de rang.
 *
 * S'exécute APRÈS `JwtAuthGuard` (ordre d'enregistrement global) : `req.authUser`
 * est donc déjà résolu. Sans métadonnée `@MinRank()`, la garde laisse passer —
 * c'est la garde d'authentification qui a déjà tranché l'accès.
 */
@Injectable()
export class RankGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const minRank = this.reflector.getAllAndOverride<number | undefined>(MIN_RANK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (minRank === undefined) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rank = req.authUser?.rank ?? 0;

    if (rank < minRank) {
      throw new ForbiddenException('Accès refusé — droits insuffisants');
    }
    return true;
  }
}
