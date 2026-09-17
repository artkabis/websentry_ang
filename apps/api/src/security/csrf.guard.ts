import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER, COOKIES, SAFE_METHODS } from '../common/constants.js';
import type { AuthenticatedRequest } from '../common/types.js';
import { AuditService } from '../audit/audit.service.js';
import { SKIP_CSRF_KEY } from '../common/decorators/skip-csrf.decorator.js';

/**
 * Double-submit cookie.
 *
 * Le serveur pose un jeton aléatoire dans un cookie NON httpOnly ; le front le
 * relit et le renvoie dans l'en-tête `X-CSRF-Token`. Un site tiers peut faire
 * partir une requête avec les cookies de la victime (SameSite mis à part), mais
 * il ne peut pas LIRE ce cookie pour reconstituer l'en-tête — la politique
 * d'origine identique l'en empêche.
 *
 * Portée : toutes les mutations authentifiées PAR COOKIE. Les clients Bearer sont
 * exemptés — ils n'envoient pas de cookie, donc aucune requête inter-site ne peut
 * emprunter leurs identifiants.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Méthodes sans effet de bord : rien à protéger.
    if (SAFE_METHODS.includes(req.method)) return true;

    // Client Bearer : pas de cookie ambiant, donc pas de vecteur CSRF.
    if (req.authVia !== 'cookie') return true;

    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const cookieToken = cookies?.[COOKIES.CSRF];
    const headerToken = req.headers[CSRF_HEADER];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerValue || cookieToken !== headerValue) {
      void this.audit.record({
        actorId: req.authUser?.sub ?? null,
        actorName: req.authUser?.username ?? 'unknown',
        action: 'auth.csrf_failed',
        details: { method: req.method, url: req.url },
        ipAddress: req.ip ?? null,
      });
      throw new ForbiddenException('Token CSRF invalide ou manquant');
    }

    return true;
  }
}
