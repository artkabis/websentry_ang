import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import {
  GammeParamSchema,
  ImportProfileSchema,
  SaveProfileSchema,
  type ImportProfileInput,
  type ProfileExport,
  type ProfileMeta,
  type SaveProfileInput,
  type SettingsProfile,
} from '@websentry/shared';
import { CurrentUser, RequireAdmin } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ProfilesService, type WriteContext } from './profiles.service.js';

/**
 * CRUD des profils par gamme.
 *
 * Les LECTURES sont ouvertes à tout compte authentifié : un testeur doit
 * pouvoir consulter les réglages appliqués à ses scans. Les ÉCRITURES exigent
 * le rang administrateur — parité stricte avec la v1, qui gardait ces routes
 * par le rang et non par une permission fine.
 */
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  private contextOf(req: AuthenticatedRequest, user: AuthUser): WriteContext {
    return { actorId: user.sub, actorName: user.username, ipAddress: req.ip ?? null };
  }

  /** GET /api/v1/profiles — métadonnées seules, sans les réglages. */
  @Get()
  list(): Promise<ProfileMeta[]> {
    return this.profiles.list();
  }

  /** GET /api/v1/profiles/:gamme */
  @Get(':gamme')
  get(@Param('gamme', { schema: GammeParamSchema }) gamme: string): Promise<SettingsProfile> {
    return this.profiles.get(gamme);
  }

  /**
   * GET /api/v1/profiles/:gamme/export
   *
   * Même niveau d'accès que la lecture du profil : l'export n'expose rien de
   * plus, il change seulement la forme. Le nom de fichier est construit à
   * partir de la gamme NORMALISÉE, jamais de l'entrée brute — un en-tête
   * `Content-Disposition` est un vecteur d'injection s'il n'est pas borné.
   */
  @Get(':gamme/export')
  @Header('Cache-Control', 'no-store')
  async exportProfile(
    @Param('gamme', { schema: GammeParamSchema }) gamme: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProfileExport> {
    const payload = await this.profiles.export(gamme);
    void reply.header(
      'Content-Disposition',
      `attachment; filename="websentry-profil-${payload.profile}.json"`,
    );
    return payload;
  }

  /**
   * PUT /api/v1/profiles/:gamme — création ou mise à jour.
   *
   * Limite serrée : l'édition de profils est une action humaine et rare, et la
   * charge utile est volumineuse.
   */
  @RequireAdmin()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put(':gamme')
  save(
    @Param('gamme', { schema: GammeParamSchema }) gamme: string,
    @Body({ schema: SaveProfileSchema }) body: SaveProfileInput,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<SettingsProfile> {
    return this.profiles.save(gamme, body, this.contextOf(req, user));
  }

  /** POST /api/v1/profiles/:gamme/import */
  @RequireAdmin()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':gamme/import')
  @HttpCode(HttpStatus.OK)
  importProfile(
    @Param('gamme', { schema: GammeParamSchema }) gamme: string,
    @Body({ schema: ImportProfileSchema }) body: ImportProfileInput,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<SettingsProfile> {
    return this.profiles.import(
      gamme,
      body.payload,
      body.expectedVersion,
      this.contextOf(req, user),
    );
  }

  /** POST /api/v1/profiles/:gamme/reset — retour aux valeurs par défaut. */
  @RequireAdmin()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':gamme/reset')
  @HttpCode(HttpStatus.OK)
  reset(
    @Param('gamme', { schema: GammeParamSchema }) gamme: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<SettingsProfile> {
    return this.profiles.reset(gamme, this.contextOf(req, user));
  }

  /** DELETE /api/v1/profiles/:gamme — `default` est protégé. */
  @RequireAdmin()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete(':gamme')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('gamme', { schema: GammeParamSchema }) gamme: string,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.profiles.remove(gamme, this.contextOf(req, user));
  }
}
