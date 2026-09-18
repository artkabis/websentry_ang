import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { rankToRole, type AuthSession, type CurrentUser, type Role } from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../security/password.service.js';
import { RbacService } from '../rbac/rbac.service.js';
import { SessionRepository } from '../database/repositories/session.repository.js';
import { UserRepository, type UserRow } from '../database/repositories/user.repository.js';
import { TokenService } from './token.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/** Jetons émis à l'issue d'une authentification réussie. */
export interface IssuedTokens {
  accessToken: string;
  accessMaxAge: number;
  refreshToken: string;
  refreshMaxAge: number;
  csrfToken: string;
  role: Role;
  username: string;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** Plafond absolu du TTL d'un access token, quelle que soit la configuration. */
const ACCESS_TOKEN_HARD_CAP_SEC = 15 * 60;

/**
 * Délai appliqué à tout échec d'authentification.
 *
 * Aplanit ce qui reste d'écart de temps entre les chemins d'échec (identifiant
 * inconnu, mot de passe faux) et ralentit mécaniquement le balayage d'identifiants.
 */
const FAILED_LOGIN_DELAY_MS = 500;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Hash factice, calculé une fois au démarrage.
   *
   * Sur identifiant inconnu, on vérifie le mot de passe CONTRE CE HASH : le coût
   * scrypt est donc payé dans tous les cas. Sans cela, la réponse immédiate sur
   * compte inexistant révélerait, au chronomètre, quels identifiants existent.
   */
  private dummyHash: string | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly throttle: LoginThrottleService,
    private readonly config: AppConfigService,
  ) {}

  /** TTL effectif de l'access token — jamais au-delà du plafond dur. */
  private get accessTtlSec(): number {
    return Math.min(this.config.accessTokenTtl, ACCESS_TOKEN_HARD_CAP_SEC);
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHash ??= await this.passwords.hash(randomBytes(32).toString('hex'));
    return this.dummyHash;
  }

  /** Jeton CSRF : aléatoire, lié à la session, jamais dérivé de l'identité. */
  private newCsrfToken(): string {
    return randomBytes(24).toString('base64url');
  }

  // ── Connexion ─────────────────────────────────────────────────────────────

  async login(rawUsername: string, password: string, ctx: RequestContext): Promise<IssuedTokens> {
    const username = rawUsername.toLowerCase().trim();
    const ip = ctx.ip ?? 'unknown';

    // 1. Limite par (IP, identifiant) — avant toute requête en base.
    const retryAfter = this.throttle.hit(ip, username);
    if (retryAfter > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Trop de requêtes',
          message: `Limite dépassée. Réessayez dans ${retryAfter}s.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.users.available) {
      throw new ServiceUnavailableException('Authentification non configurée sur le serveur');
    }

    const user = await this.users.findByUsername(username);

    // 2. Vérification du mot de passe — TOUJOURS exécutée, même sans compte.
    const targetHash = user ? user.password_hash : await this.getDummyHash();
    const passwordOk = await this.passwords.verify(password, targetHash);

    if (!user || !passwordOk) {
      await this.onFailedLogin(user, username, ip);
      await this.delay(FAILED_LOGIN_DELAY_MS);
      // Message VOLONTAIREMENT indifférencié : distinguer « compte inconnu » de
      // « mot de passe invalide » livrerait un oracle d'énumération de comptes.
      throw new UnauthorizedException('Identifiants incorrects');
    }

    // 3. Verrouillage temporaire — vérifié APRÈS le mot de passe, afin de ne pas
    //    révéler l'état de verrouillage à qui ne connaît pas le mot de passe.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const seconds = Math.max(
        1,
        Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000),
      );
      await this.audit.record({
        actorId: null,
        actorName: username,
        action: 'auth.login_failed',
        targetId: user.id,
        targetType: 'user',
        details: { reason: 'account_locked' },
        ipAddress: ip,
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Trop de requêtes',
          message: 'Compte temporairement verrouillé — réessayez plus tard',
          retryAfter: seconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 4. Statut du compte.
    if (user.status === 'suspended') {
      await this.audit.record({
        actorId: null,
        actorName: username,
        action: 'auth.login_failed',
        targetId: user.id,
        targetType: 'user',
        details: { reason: 'account_suspended' },
        ipAddress: ip,
      });
      throw new ForbiddenException('Compte suspendu — contactez un administrateur');
    }
    if (user.status === 'pending') {
      throw new ForbiddenException("Compte en attente d'activation");
    }

    // 5. Succès — remise à zéro des compteurs et émission des jetons.
    await this.users.resetFailedLogins(user.id);
    this.throttle.clear(ip, username);

    const issued = await this.issueTokens(user, ctx);

    await this.audit.record({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.login',
      targetId: user.id,
      targetType: 'user',
      details: { role: issued.role },
      ipAddress: ip,
    });
    this.logger.log(`Connexion — ${user.username} (rang ${user.rank})`);

    return issued;
  }

  /**
   * Compte les échecs et verrouille au seuil configuré.
   *
   * Sur identifiant inconnu il n'y a rien à incrémenter : la temporisation et le
   * limiteur par couple (IP, identifiant) assurent seuls la protection.
   */
  private async onFailedLogin(user: UserRow | null, username: string, ip: string): Promise<void> {
    if (user) {
      const failed = (user.failed_logins ?? 0) + 1;
      const shouldLock = failed >= this.config.loginMaxAttempts;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + this.config.loginLockoutSeconds * 1000)
        : null;

      await this.users.recordFailedLogin(user.id, failed, lockedUntil).catch(() => undefined);

      if (shouldLock) {
        await this.audit.record({
          actorId: null,
          actorName: username,
          action: 'auth.account_locked',
          targetId: user.id,
          targetType: 'user',
          details: { lockedUntil: lockedUntil?.toISOString(), failedAttempts: failed },
          ipAddress: ip,
        });
      }
    }

    await this.audit.record({
      actorId: null,
      actorName: username,
      action: 'auth.login_failed',
      targetId: user?.id ?? null,
      targetType: user ? 'user' : null,
      details: { reason: 'invalid_credentials' },
      ipAddress: ip,
    });
  }

  // ── Rotation du refresh token ─────────────────────────────────────────────

  /**
   * Échange un refresh token contre un couple neuf.
   *
   * Le jeton présenté est révoqué et remplacé DANS LA MÊME TRANSACTION : il est
   * strictement à usage unique. Un jeton volé puis rejoué après un refresh légitime
   * tombe donc sur une session révoquée et se voit refusé.
   */
  async refresh(rawRefreshToken: string, ctx: RequestContext): Promise<IssuedTokens> {
    if (!this.users.available) {
      throw new ServiceUnavailableException('Rafraîchissement indisponible');
    }

    const session = await this.sessions.findByRawToken(rawRefreshToken);

    if (
      !session ||
      session.revoked === 1 ||
      session.status !== 'active' ||
      new Date(session.expires_at) <= new Date()
    ) {
      throw new UnauthorizedException('Session invalide ou expirée — reconnexion requise');
    }

    const user = await this.users.findById(session.user_id);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Utilisateur inactif');
    }

    const newRefreshToken = await this.sessions.rotate(
      session.session_id,
      user.id,
      this.config.refreshTokenTtl * 1000,
      ctx.ip,
      ctx.userAgent,
    );

    const accessToken = await this.tokens.sign(
      {
        sub: user.id,
        username: user.username,
        rank: user.rank,
        version: user.token_version,
      },
      this.accessTtlSec,
    );

    await this.audit.record({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.refresh',
      targetId: user.id,
      targetType: 'user',
      details: {},
      ipAddress: ctx.ip,
    });

    return {
      accessToken,
      accessMaxAge: this.accessTtlSec,
      refreshToken: newRefreshToken,
      refreshMaxAge: this.config.refreshTokenTtl,
      csrfToken: this.newCsrfToken(),
      role: rankToRole(user.rank),
      username: user.username,
    };
  }

  // ── Déconnexion ───────────────────────────────────────────────────────────

  /** Révoque toutes les sessions de l'utilisateur. Idempotent. */
  async logout(userId: string, username: string, ip: string | null): Promise<void> {
    if (this.users.available) {
      await this.sessions.revokeAllForUser(userId).catch(() => undefined);
    }
    await this.audit.record({
      actorId: userId,
      actorName: username,
      action: 'auth.logout',
      details: {},
      ipAddress: ip,
    });
  }

  // ── Profil ────────────────────────────────────────────────────────────────

  /**
   * Profil de l'utilisateur authentifié.
   *
   * Construit champ par champ : le DTO de sortie est une liste blanche, jamais un
   * `UserRow` dont on aurait « retiré » quelques colonnes (OWASP #7).
   */
  async currentUser(userId: string): Promise<CurrentUser> {
    const row = await this.users.findById(userId);
    if (!row) throw new UnauthorizedException('Utilisateur introuvable');

    const permissions = await this.rbac.listForUser(row.id).catch(() => []);

    return {
      id: row.id,
      username: row.username,
      rank: row.rank,
      role: rankToRole(row.rank),
      status: row.status,
      permissions,
    };
  }

  // ── Interne ───────────────────────────────────────────────────────────────

  private async issueTokens(user: UserRow, ctx: RequestContext): Promise<IssuedTokens> {
    const accessToken = await this.tokens.sign(
      {
        sub: user.id,
        username: user.username,
        rank: user.rank,
        version: user.token_version,
      },
      this.accessTtlSec,
    );

    const refreshToken = await this.sessions.create(
      user.id,
      this.config.refreshTokenTtl * 1000,
      ctx.ip,
      ctx.userAgent,
    );

    return {
      accessToken,
      accessMaxAge: this.accessTtlSec,
      refreshToken,
      refreshMaxAge: this.config.refreshTokenTtl,
      csrfToken: this.newCsrfToken(),
      role: rankToRole(user.rank),
      username: user.username,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Réponse publique après connexion — strictement `{ role, username }`. */
  toAuthSession(issued: IssuedTokens): AuthSession {
    return { role: issued.role, username: issued.username };
  }
}
