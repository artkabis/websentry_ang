import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  DEFAULT_PROFILE,
  SaveSettingsSchema,
  type SaveSettingsInput,
  type SettingsProfile,
} from '@websentry/shared';
import { CurrentUser, RequireAdmin } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ProfilesService, type WriteContext } from '../profiles/profiles.service.js';

/**
 * Réglages GLOBAUX.
 *
 * Ils sont exactement le profil `default`. La v1 tenait deux fichiers distincts
 * — `settings.json` et `settings-default.json` — qui remplissaient le même rôle
 * et pouvaient diverger sans que rien ne le signale. Les endpoints restent
 * séparés pour la compatibilité des clients, mais s'appuient désormais sur une
 * seule ligne en base (cf. docs/DECISIONS.md).
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly profiles: ProfilesService) {}

  private contextOf(req: AuthenticatedRequest, user: AuthUser): WriteContext {
    return { actorId: user.sub, actorName: user.username, ipAddress: req.ip ?? null };
  }

  /** GET /api/v1/settings — accessible à tout compte authentifié. */
  @Get()
  get(): Promise<SettingsProfile> {
    return this.profiles.get(DEFAULT_PROFILE);
  }

  /** PUT /api/v1/settings */
  @RequireAdmin()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put()
  save(
    @Body({ schema: SaveSettingsSchema }) body: SaveSettingsInput,
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<SettingsProfile> {
    return this.profiles.save(DEFAULT_PROFILE, body, this.contextOf(req, user));
  }

  /** POST /api/v1/settings/reset */
  @RequireAdmin()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset')
  @HttpCode(HttpStatus.OK)
  reset(@Req() req: AuthenticatedRequest, @CurrentUser() user: AuthUser): Promise<SettingsProfile> {
    return this.profiles.reset(DEFAULT_PROFILE, this.contextOf(req, user));
  }
}
