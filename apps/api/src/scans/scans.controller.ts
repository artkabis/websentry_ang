import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  BulkDeleteSchema,
  PERMISSIONS,
  RANKS,
  ScanDomainSchema,
  ScanSearchQuerySchema,
  ScanUuidSchema,
  SiteDeleteSchema,
  SiteSelectorSchema,
  type BulkDelete,
  type DeleteResult,
  type ScanPage,
  type ScanPageList,
  type ScanSearchQuery,
  type ScanStats,
  type SessionComparison,
  type SessionReport,
  type SiteDelete,
  type SiteList,
  type SiteSelector,
  type SiteSession,
} from '@websentry/shared';
import { CurrentUser, RequirePermission } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ScansService, type ScanActor } from './scans.service.js';

/**
 * Historique des scans.
 *
 * Deux ouvertures distinctes, et la distinction est le cœur du modèle d'accès :
 *
 *   • `history:read` donne accès à l'historique de TOUS les sites. Détenue par
 *     défaut par l'administrateur et l'éditeur, délégable à un testeur sur un
 *     périmètre de gammes.
 *   • `/scans/mine/:id` n'exige aucune permission : tout compte authentifié
 *     relit les sessions QU'IL A LANCÉES. Sans cette route, un testeur ne
 *     pourrait pas revoir son propre audit de la veille.
 *
 * Les suppressions exigent `history:delete`, que seul l'administrateur détient
 * par défaut. Elles sont irréversibles : la limite de débit y est donc serrée,
 * moins pour la charge que pour borner les dégâts d'un jeton volé.
 */
@Controller('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  private actorOf(req: AuthenticatedRequest, user: AuthUser): ScanActor {
    return { actorId: user.sub, actorName: user.username, ipAddress: req.ip ?? null };
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/scans — recherche paginée dans les pages analysées.
   *
   * Déclarée AVANT les routes à segment variable : l'ordre de déclaration décide
   * en cas d'ambiguïté, et `/scans/sites` ne doit jamais être lu comme un
   * identifiant de page.
   */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  search(@Query({ schema: ScanSearchQuerySchema }) query: ScanSearchQuery): Promise<ScanPageList> {
    return this.scans.searchPages(query);
  }

  /** GET /api/v1/scans/sites — un site par ligne, résumé par sa dernière session. */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('sites')
  listSites(@Query({ schema: ScanSearchQuerySchema }) query: ScanSearchQuery): Promise<SiteList> {
    return this.scans.listSites(query);
  }

  /** GET /api/v1/scans/sites/sessions?domain=&gamme= — l'historique d'un site. */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('sites/sessions')
  listSiteSessions(
    @Query({ schema: SiteSelectorSchema }) query: SiteSelector,
  ): Promise<SiteSession[]> {
    return this.scans.listSiteSessions(query.domain, query.gamme);
  }

  /**
   * GET /api/v1/scans/stats — statistiques agrégées.
   *
   * Limite plus basse que les listes : chaque calcul balaie la table entière.
   * Le cache d'une minute absorbe les rafraîchissements, la limite protège du
   * reste.
   */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('stats')
  stats(): Promise<ScanStats> {
    return this.scans.getStats();
  }

  /**
   * GET /api/v1/scans/mine/:sessionId — une session que l'appelant a lancée.
   *
   * Aucune permission requise, mais un contrôle d'appartenance strict côté
   * service. C'est la seule route de l'historique ouverte au rang testeur.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('mine/:sessionId')
  getOwnSession(
    @Param('sessionId', { schema: ScanUuidSchema }) sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SessionReport> {
    return this.scans.getOwnSessionReport(sessionId, user.username, user.rank >= RANKS.ADMIN);
  }

  /** GET /api/v1/scans/sessions/:sessionId — détail d'un audit et de ses pages. */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('sessions/:sessionId')
  getSession(
    @Param('sessionId', { schema: ScanUuidSchema }) sessionId: string,
  ): Promise<SessionReport> {
    return this.scans.getSessionReport(sessionId);
  }

  /**
   * GET /api/v1/scans/sessions/:baseId/compare/:targetId
   *
   * Compare deux audits du même site. L'ordre des identifiants n'a pas
   * d'importance : le plus ancien sert toujours de référence, si bien qu'un
   * delta négatif signifie « ça a baissé » quel que soit le lien cliqué.
   */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('sessions/:baseId/compare/:targetId')
  compare(
    @Param('baseId', { schema: ScanUuidSchema }) baseId: string,
    @Param('targetId', { schema: ScanUuidSchema }) targetId: string,
  ): Promise<SessionComparison> {
    return this.scans.compareSessions(baseId, targetId);
  }

  /**
   * GET /api/v1/scans/:pageId — rapport complet d'une page.
   *
   * Trois issues : 200 avec le rapport, 404 si la page n'existe pas, 410 si la
   * rétention a purgé son rapport — auquel cas la réponse porte la date de purge.
   */
  @RequirePermission(PERMISSIONS.HISTORY_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':pageId')
  getPage(
    @Param('pageId', { schema: ScanUuidSchema }) pageId: string,
  ): Promise<{ scan: ScanPage; report: unknown }> {
    return this.scans.getPageReport(pageId);
  }

  // ── Suppression ────────────────────────────────────────────────────────────

  /** DELETE /api/v1/scans — suppression en masse par identifiants de page. */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Delete()
  @HttpCode(HttpStatus.OK)
  async deletePages(
    @Body({ schema: BulkDeleteSchema }) body: BulkDelete,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<DeleteResult> {
    return { deleted: await this.scans.deletePages(body.ids, this.actorOf(req, user)) };
  }

  /**
   * DELETE /api/v1/scans/sites — un site entier, couple (domaine, gamme).
   *
   * La cible passe par le CORPS et non par l'URL : `gamme: null` désigne le site
   * sans gamme, et une URL ne sait pas distinguer « absent » de « vide ». Le
   * corps permet de l'exiger explicitement.
   */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Delete('sites')
  @HttpCode(HttpStatus.OK)
  async deleteSite(
    @Body({ schema: SiteDeleteSchema }) body: SiteDelete,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<DeleteResult> {
    const deleted = await this.scans.deleteSite(body.domain, body.gamme, this.actorOf(req, user));
    return { deleted };
  }

  /** DELETE /api/v1/scans/sessions/:sessionId — un audit et ses pages. */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  async deleteSession(
    @Param('sessionId', { schema: ScanUuidSchema }) sessionId: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<DeleteResult> {
    return { deleted: await this.scans.deleteSession(sessionId, this.actorOf(req, user)) };
  }

  /**
   * DELETE /api/v1/scans/domains/:domain — toutes les gammes d'un domaine.
   *
   * L'action la plus destructrice du module : elle efface plusieurs sites d'un
   * coup. Limite la plus serrée, et journalisation systématique côté service.
   */
  @RequirePermission(PERMISSIONS.HISTORY_DELETE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete('domains/:domain')
  @HttpCode(HttpStatus.OK)
  async deleteDomain(
    @Param('domain', { schema: ScanDomainSchema }) domain: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<DeleteResult> {
    return { deleted: await this.scans.deleteDomain(domain, this.actorOf(req, user)) };
  }
}
