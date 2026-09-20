import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import {
  ANALYZERS_REGISTRY,
  AnalyzableUrlSchema,
  AnalyzeRequestSchema,
  BatchRequestSchema,
  PERMISSIONS,
  SitemapRequestSchema,
  type AnalysisReport,
  type AnalyzeRequest,
  type BatchRequest,
  type BatchResponse,
  type SitemapParseResponse,
  type SitemapRequest,
} from '@websentry/shared';
import { CurrentUser, RequirePermission } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { RbacService } from '../rbac/rbac.service.js';
import { AnalysisService, type AnalysisActor } from './analysis.service.js';
import { SitemapService } from './sitemap.service.js';
import { SseWriter } from './sse-writer.js';

/**
 * Moteur d'analyse.
 *
 * C'est le seul module qui émette des requêtes vers l'extérieur : chaque route
 * ici déclenche, directement ou non, une connexion sortante vers une URL FOURNIE
 * PAR L'APPELANT. D'où des limites de débit serrées, et une permission
 * (`scan:run`) distincte de la simple authentification — un compte compromis ne
 * doit pas transformer le serveur en relais.
 */
@Controller()
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly sitemap: SitemapService,
    private readonly rbac: RbacService,
  ) {}

  /**
   * L'appelant peut-il imposer un profil ?
   *
   * La réponse ne BLOQUE jamais l'analyse : sans la permission, le profil
   * choisi est ignoré au profit de celui détecté dans la page.
   */
  private async actorOf(user: AuthUser): Promise<AnalysisActor> {
    const granted = await this.rbac
      .resolve(user.sub, user.rank, PERMISSIONS.PROFILES_USE)
      .catch(() => null);
    return { username: user.username, canChooseProfile: granted !== null };
  }

  /** GET /api/v1/analyze/checks — catalogue des critères, pour l'interface. */
  @RequirePermission(PERMISSIONS.SCAN_RUN)
  @Get('analyze/checks')
  checks(): typeof ANALYZERS_REGISTRY {
    return ANALYZERS_REGISTRY;
  }

  /** POST /api/v1/analyze — analyse d'une page. */
  @RequirePermission(PERMISSIONS.SCAN_RUN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  async analyze(
    @Body({ schema: AnalyzeRequestSchema }) body: AnalyzeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<AnalysisReport> {
    const actor = await this.actorOf(user);
    return this.analysis.analyzePage(body.url, actor, {
      settingsOverride: body.settings,
      profileOverride: body.profileOverride,
    });
  }

  /**
   * POST /api/v1/analyze/batch — analyse d'un lot.
   *
   * Limite plus basse que l'analyse unitaire : un lot vaut jusqu'à deux cents
   * pages, donc autant de requêtes sortantes par appel.
   */
  @RequirePermission(PERMISSIONS.SCAN_BATCH)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('analyze/batch')
  @HttpCode(HttpStatus.OK)
  async batch(
    @Body({ schema: BatchRequestSchema }) body: BatchRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<BatchResponse> {
    const actor = await this.actorOf(user);
    return this.analysis.analyzeBatch(body.urls, actor, {
      settingsOverride: body.settings,
      profileOverride: body.profileOverride,
    });
  }

  /**
   * POST /api/v1/analyze/stream — analyse d'une page, progression en direct.
   *
   * Le flux prend la main sur la réponse : le filtre d'exceptions global ne
   * peut plus rien y faire une fois les en-têtes partis. Les erreurs sont donc
   * assainies ET émises ICI, sous forme d'événement `error`.
   */
  @RequirePermission(PERMISSIONS.SCAN_RUN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('analyze/stream')
  async stream(
    @Body({ schema: AnalyzeRequestSchema }) body: AnalyzeRequest,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const writer = new SseWriter(reply, request);
    const actor = await this.actorOf(user);
    // L'identifiant est tiré ICI : les événements le portent tous, y compris
    // celui émis quand la page ne répond pas — donc avant qu'un rapport existe.
    const analyzeId = randomUUID();

    try {
      let announced = false;
      const report = await this.analysis.analyzePage(
        body.url,
        actor,
        {
          settingsOverride: body.settings,
          profileOverride: body.profileOverride,
          analyzeId,
        },
        (result, completed, total) => {
          // `start` est émis au PREMIER critère terminé : c'est le moment où la
          // page a répondu et où l'on connaît le nombre de critères.
          if (!announced) {
            announced = true;
            writer.send({ type: 'start', analyzeId, url: body.url, total });
          }
          writer.send({ type: 'check', analyzeId, completed, total, result });
        },
      );

      writer.send({ type: 'complete', analyzeId, report });
    } catch (err) {
      writer.sendError(err, analyzeId);
    } finally {
      writer.close();
    }
  }

  /** GET /api/v1/sitemap/detect?url= — cherche le sitemap d'un site. */
  @RequirePermission(PERMISSIONS.SCAN_BATCH)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('sitemap/detect')
  async detect(
    @Query('url', { schema: AnalyzableUrlSchema }) url: string,
  ): Promise<{ sitemapUrl: string | null }> {
    return { sitemapUrl: await this.sitemap.detect(url) };
  }

  /** POST /api/v1/sitemap/parse — lit un sitemap et en extrait les URL. */
  @RequirePermission(PERMISSIONS.SCAN_BATCH)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sitemap/parse')
  @HttpCode(HttpStatus.OK)
  parse(
    @Body({ schema: SitemapRequestSchema }) body: SitemapRequest,
  ): Promise<SitemapParseResponse> {
    return this.sitemap.parse(body.url, {
      limit: body.limit,
      filterByPriority: body.filterByPriority,
    });
  }
}
