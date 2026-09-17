import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionCode } from '@websentry/shared';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator.js';
import type { AuthenticatedRequest } from '../../common/types.js';
import { AuditService } from '../../audit/audit.service.js';
import { RbacService } from '../../rbac/rbac.service.js';

/**
 * Permissions fines.
 *
 * Tout refus est JOURNALISÉ (`auth.permission_denied`) : une tentative d'élévation
 * de privilège doit laisser une trace, sans quoi la détection d'abus est aveugle
 * (OWASP #11).
 *
 * Le scope de gammes résolu est déposé dans `req.authPermission` pour que le
 * contrôleur puisse le confronter à la gamme réellement demandée.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const code = this.reflector.getAllAndOverride<PermissionCode | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!code) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.authUser;
    if (!user) throw new UnauthorizedException('Non authentifié');

    let granted: { gammes: string[] | null } | null;
    try {
      granted = await this.rbac.resolve(user.sub, user.rank, code);
    } catch {
      throw new ServiceUnavailableException('Vérification des permissions indisponible');
    }

    if (!granted) {
      void this.audit.record({
        actorId: user.sub,
        actorName: user.username,
        action: 'auth.permission_denied',
        details: { permission: code, method: req.method, url: req.url },
        ipAddress: req.ip ?? null,
      });
      throw new ForbiddenException(`Permission requise : ${code}`);
    }

    req.authPermission = { permission: code, gammes: granted.gammes };
    return true;
  }
}
