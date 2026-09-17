import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COOKIES } from '../../common/constants.js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import type { AuthenticatedRequest, AuthUser, AuthVia } from '../../common/types.js';
import { UserRepository } from '../../database/repositories/user.repository.js';
import { TokenService } from '../token.service.js';

/**
 * Garde d'authentification appliqué GLOBALEMENT.
 *
 * Toute route est fermée par défaut ; seul `@Public()` l'ouvre. C'est le sens de
 * lecture le plus sûr : un endpoint ajouté sans y penser est protégé, pas exposé.
 *
 * Deux porteurs de jeton sont acceptés, dans cet ordre :
 *   1. le cookie httpOnly `ws_access` (navigateur) ;
 *   2. l'en-tête `Authorization: Bearer` (clients API).
 *
 * Le mode retenu est mémorisé dans `req.authVia` : c'est lui qui décide si la
 * garde CSRF s'applique en aval.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const resolved = await this.resolve(req);

    if (!resolved) {
      throw new UnauthorizedException('Non authentifié — token manquant ou invalide');
    }

    if (!(await this.isTokenVersionCurrent(resolved.user))) {
      throw new UnauthorizedException('Session expirée — reconnexion requise');
    }

    req.authUser = resolved.user;
    req.authVia = resolved.via;
    return true;
  }

  /** Extrait et vérifie le jeton, cookie d'abord puis Bearer. */
  private async resolve(
    req: AuthenticatedRequest,
  ): Promise<{ user: AuthUser; via: AuthVia } | null> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const cookieToken = cookies?.[COOKIES.ACCESS];
    if (cookieToken) {
      const user = await this.tokens.verify(cookieToken);
      if (user) return { user, via: 'cookie' };
    }

    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const user = await this.tokens.verify(authorization.slice(7));
      if (user) return { user, via: 'bearer' };
    }

    return null;
  }

  /**
   * Confronte la version du jeton à celle stockée en base.
   *
   * C'est le mécanisme de RÉVOCATION : incrémenter `users.token_version` invalide
   * instantanément tous les access tokens émis, sans attendre leur expiration. Le
   * statut du compte (suspendu, en attente) est vérifié dans la même requête.
   *
   * Base indisponible → on REFUSE. Le repli permissif de la v1 (« ne pas bloquer
   * l'authentification ») rendait la révocation contournable en faisant tomber la
   * base : ici, une panne dégrade la disponibilité, jamais l'autorisation.
   */
  private async isTokenVersionCurrent(user: AuthUser): Promise<boolean> {
    if (!this.users.available) return true; // Déploiement sans base — rien à confronter.

    let row: Awaited<ReturnType<UserRepository['findById']>>;
    try {
      row = await this.users.findById(user.sub);
    } catch {
      throw new ServiceUnavailableException('Vérification de session indisponible');
    }

    if (!row) return false; // Compte supprimé.
    if (row.status !== 'active') return false; // Suspendu ou en attente d'activation.
    return row.token_version === user.version;
  }
}
