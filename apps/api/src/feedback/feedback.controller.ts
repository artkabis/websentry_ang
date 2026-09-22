import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as z from 'zod';
import {
  CreateFeedbackSchema,
  FeedbackQuerySchema,
  PERMISSIONS,
  TriageFeedbackSchema,
  type CreateFeedbackInput,
  type Feedback,
  type FeedbackCounts,
  type FeedbackListResponse,
  type FeedbackQuery,
  type TriageFeedbackInput,
} from '@websentry/shared';
import { CurrentUser } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { RbacService } from '../rbac/rbac.service.js';
import { FeedbackService, type FeedbackActor } from './feedback.service.js';

const IdParamSchema = z.uuid();

/**
 * Retours des bêta-testeurs.
 *
 * Aucune route ne porte de décorateur de permission, et c'est VOLONTAIRE :
 * déposer un retour est ouvert à tout compte authentifié, et la lecture est
 * ouverte aussi — mais restreinte à ses propres retours pour qui n'a pas
 * `feedback:read`. Cette restriction dépend de l'acteur ET de la ligne visée,
 * ce qu'une garde de route ne voit pas : elle vit donc dans le service.
 *
 * Une garde `@RequirePermission(FEEDBACK_READ)` sur la liste fermerait l'écran
 * « mes retours » à ceux-là mêmes qu'on veut faire remonter des retours.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly rbac: RbacService,
  ) {}

  private async actorOf(req: AuthenticatedRequest, user: AuthUser): Promise<FeedbackActor> {
    return {
      id: user.sub,
      username: user.username,
      ipAddress: req.ip ?? null,
      peutTrier: (await this.rbac.resolve(user.sub, user.rank, PERMISSIONS.FEEDBACK_READ)) !== null,
    };
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  async list(
    @Query({ schema: FeedbackQuerySchema }) requete: FeedbackQuery,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<FeedbackListResponse> {
    return this.feedback.list(requete, await this.actorOf(req, user));
  }

  @Get('compteurs')
  async counts(
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<FeedbackCounts> {
    return this.feedback.counts(await this.actorOf(req, user));
  }

  @Get(':id')
  async get(
    @Param('id', { schema: IdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Feedback> {
    return this.feedback.get(id, await this.actorOf(req, user));
  }

  /**
   * Dépôt d'un retour.
   *
   * Limite serrée : c'est une action humaine et rare, et la charge utile est
   * stockée telle quelle. Sans borne, un script en remplirait la table.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async create(
    @Body({ schema: CreateFeedbackSchema }) body: CreateFeedbackInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Feedback> {
    return this.feedback.create(body, await this.actorOf(req, user));
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  async triage(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: TriageFeedbackSchema }) body: TriageFeedbackInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Feedback> {
    return this.feedback.triage(id, body, await this.actorOf(req, user));
  }
}
