import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import {
  LoginSchema,
  type AuthSession,
  type CurrentUser as CurrentUserDto,
  type LoginInput,
} from '@websentry/shared';
import { COOKIES, REFRESH_COOKIE_PATH } from '../common/constants.js';
import { CurrentUser, Public, SkipCsrf } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { AppConfigService } from '../config/app-config.service.js';
import { AuthService, type IssuedTokens } from './auth.service.js';

/**
 * Endpoints d'authentification.
 *
 * Les jetons ne transitent JAMAIS dans le corps de réponse : ils sont posés en
 * cookies httpOnly. Un XSS ne peut donc pas les lire — c'est toute la raison de ce
 * choix face au stockage en `localStorage`.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * POST /api/v1/auth/login
   *
   * Public (aucune session préalable) et exempté de CSRF : à ce stade le client ne
   * détient encore aucun jeton CSRF à présenter. Limite volumétrique serrée par IP,
   * en complément du compteur par (IP, identifiant) appliqué dans le service.
   */
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 50, ttl: 15 * 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    // Le schéma Zod PARTAGÉ est passé directement au décorateur : Nest 12 le
    // consomme via Standard Schema. Le front valide la même forme, depuis la même
    // définition — aucune divergence possible entre les deux côtés.
    @Body({ schema: LoginSchema }) dto: LoginInput,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const issued = await this.auth.login(dto.username, dto.password, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    this.setAuthCookies(reply, issued);
    return this.auth.toAuthSession(issued);
  }

  /**
   * POST /api/v1/auth/refresh
   *
   * Public au sens de la garde JWT : l'access token est justement expiré à ce
   * moment-là. L'autorisation vient du refresh token en cookie, dont la validité
   * est vérifiée en base, puis qui est immédiatement remplacé (rotation).
   */
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 60, ttl: 15 * 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const refreshToken = cookies?.[COOKIES.REFRESH];

    if (!refreshToken) {
      // Les cookies existants ne sont PAS effacés : un client sans refresh token
      // peut être un porteur de Bearer parfaitement valide.
      throw new UnauthorizedException('Token de rafraîchissement manquant');
    }

    try {
      const issued = await this.auth.refresh(refreshToken, {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      this.setAuthCookies(reply, issued);
      return this.auth.toAuthSession(issued);
    } catch (err) {
      // Refresh invalide = session morte : on nettoie pour éviter une boucle de
      // tentatives sur un cookie définitivement périmé.
      this.clearAuthCookies(reply);
      throw err;
    }
  }

  /**
   * POST /api/v1/auth/logout
   *
   * Authentifié ET protégé par CSRF : sans quoi un site tiers pourrait déconnecter
   * l'utilisateur à répétition (déni de service de session).
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(user.sub, user.username, req.ip ?? null);
    this.clearAuthCookies(reply);
  }

  /** GET /api/v1/auth/me — profil filtré par DTO de sortie. */
  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<CurrentUserDto> {
    return this.auth.currentUser(user.sub);
  }

  // ── Cookies ───────────────────────────────────────────────────────────────

  /**
   * Pose les quatre cookies de session.
   *
   * `ws_access` et `ws_refresh` sont httpOnly (invisibles au JavaScript).
   * `ws_csrf` et `ws_role` ne le sont PAS, à dessein : le front doit lire le jeton
   * CSRF pour le renvoyer en en-tête, et l'étiquette de rôle pour son affichage.
   * Aucun des deux n'est une source de vérité côté serveur — le rôle réel est lu
   * dans le JWT signé, jamais dans `ws_role`.
   *
   * `ws_refresh` est restreint au chemin `/api/v1/auth/refresh` : il n'est donc
   * pas transmis aux autres endpoints, ce qui réduit d'autant sa surface de fuite.
   */
  private setAuthCookies(reply: FastifyReply, issued: IssuedTokens): void {
    const base = this.config.cookieBase;

    reply.setCookie(COOKIES.ACCESS, issued.accessToken, {
      ...base,
      maxAge: issued.accessMaxAge,
    });

    reply.setCookie(COOKIES.REFRESH, issued.refreshToken, {
      ...base,
      path: REFRESH_COOKIE_PATH,
      maxAge: issued.refreshMaxAge,
    });

    const readable = { ...base, httpOnly: false as const };
    reply.setCookie(COOKIES.CSRF, issued.csrfToken, {
      ...readable,
      maxAge: issued.refreshMaxAge,
    });
    reply.setCookie(COOKIES.ROLE, issued.role, {
      ...readable,
      maxAge: issued.refreshMaxAge,
    });
  }

  private clearAuthCookies(reply: FastifyReply): void {
    const base = { ...this.config.cookieBase, maxAge: 0 };
    reply.setCookie(COOKIES.ACCESS, '', base);
    reply.setCookie(COOKIES.REFRESH, '', { ...base, path: REFRESH_COOKIE_PATH });
    reply.setCookie(COOKIES.CSRF, '', { ...base, httpOnly: false });
    reply.setCookie(COOKIES.ROLE, '', { ...base, httpOnly: false });
  }
}
