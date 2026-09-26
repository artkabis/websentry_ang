import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PERMISSIONS,
  ScanUuidSchema,
  TrashListQuerySchema,
  type TrashExport,
  type TrashListQuery,
  type TrashListResponse,
  type TrashRestoreResult,
} from '@websentry/shared';
import { CurrentUser, RequirePermission } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ScanTrashService } from './scan-trash.service.js';
import type { ScanActor } from './scans.service.js';

/**
 * Corbeille des scans.
 *
 * ── Ordre d'enregistrement ─────────────────────────────────────────────────
 * Ce contrôleur est déclaré AVANT `ScansController` dans le module, et ce n'est
 * pas indifférent : `GET /scans/:pageId` accepterait « corbeille » comme
 * identifiant de page et servirait un 400 de validation. Nest résout les routes
 * dans l'ordre de déclaration des contrôleurs. Un test E2E fixe ce point, parce
 * qu'un commentaire ne l'empêcherait pas de se défaire.
 *
 * ── Permission ─────────────────────────────────────────────────────────────
 * Tout passe par `history:delete`, le code de la v1 : qui peut supprimer peut
 * restaurer ce qu'il a supprimé, et la purge définitive est exactement la même
 * puissance destructrice que la suppression. Inventer un code absent du
 * catalogue v1 n'aurait rien durci — seulement ajouté une entrée à accorder.
 */
@Controller('scans/corbeille')
export class ScanTrashController {
  constructor(private readonly corbeille: ScanTrashService) {}

  private actorOf(req: AuthenticatedRequest, user: AuthUser): ScanActor {
    return { actorId: user.sub, actorName: user.username, ipAddress: req.ip ?? null };
  }

  /** GET /api/v1/scans/corbeille — ce qui peut encore être restauré. */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  lister(
    @Query({ schema: TrashListQuerySchema }) params: TrashListQuery,
  ): Promise<TrashListResponse> {
    return this.corbeille.lister(params);
  }

  /**
   * GET /api/v1/scans/corbeille/:id/export — l'instantané, en JSON.
   *
   * Avant l'identifiant nu, sans quoi « export » ne serait jamais atteint.
   */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get(':id/export')
  exporter(@Param('id', { schema: ScanUuidSchema }) id: string): Promise<TrashExport> {
    return this.corbeille.exporter(id);
  }

  /**
   * POST /api/v1/scans/corbeille/:id/restauration — remet les lignes en place.
   *
   * `POST` et non `PUT` : l'opération n'est pas idempotente au sens utile du
   * terme — la seconde tentative ne trouve plus l'entrée, et c'est la réponse
   * juste.
   */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/restauration')
  @HttpCode(HttpStatus.OK)
  restaurer(
    @Param('id', { schema: ScanUuidSchema }) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<TrashRestoreResult> {
    return this.corbeille.restaurer(id, this.actorOf(req, user));
  }

  /**
   * DELETE /api/v1/scans/corbeille/:id — vide l'entrée, définitivement.
   *
   * Limite la plus serrée du module : c'est le seul geste du périmètre dont
   * rien ne rattrape l'erreur.
   */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async purger(
    @Param('id', { schema: ScanUuidSchema }) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.corbeille.purger(id, this.actorOf(req, user));
  }
}
