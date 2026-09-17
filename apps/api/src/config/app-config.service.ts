import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema.js';

/**
 * Accès typé à la configuration validée.
 *
 * On n'expose JAMAIS `process.env` aux services : toute lecture passe par ici,
 * ce qui garantit qu'aucune valeur non validée n'atteint le code métier.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true }) as Env[K];
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get port(): number {
    return this.get('PORT');
  }

  get host(): string {
    return this.get('HOST');
  }

  /** Origines CORS autorisées, déjà découpées et nettoyées. */
  get corsOrigins(): string[] {
    return this.get('CORS_ORIGIN')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
  }

  get jwtSecret(): string {
    return this.get('JWT_SECRET');
  }

  get accessTokenTtl(): number {
    return this.get('ACCESS_TOKEN_TTL');
  }

  get refreshTokenTtl(): number {
    return this.get('REFRESH_TOKEN_TTL');
  }

  get loginMaxAttempts(): number {
    return this.get('LOGIN_MAX_ATTEMPTS');
  }

  get loginLockoutSeconds(): number {
    return this.get('LOGIN_LOCKOUT_SECONDS');
  }

  get dbEnabled(): boolean {
    return this.get('DB_ENABLED');
  }

  get database(): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    connectionLimit: number;
  } {
    return {
      host: this.get('DB_HOST'),
      port: this.get('DB_PORT'),
      database: this.get('DB_NAME'),
      user: this.get('DB_USER'),
      password: this.get('DB_PASSWORD'),
      connectionLimit: this.get('DB_CONNECTION_LIMIT'),
    };
  }

  get fetchUserAgent(): string {
    return this.get('FETCH_USER_AGENT');
  }

  get fetchTimeoutMs(): number {
    return this.get('FETCH_TIMEOUT_MS');
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }

  /**
   * Options de cookie appliquées à TOUS les cookies d'authentification.
   *
   * `secure` suit l'environnement : en développement le front tourne en HTTP sur
   * localhost, où un cookie `Secure` ne serait jamais renvoyé. En production, il
   * est toujours actif — aucune bascule par variable d'environnement, pour qu'une
   * mauvaise configuration ne puisse pas dégrader la sécurité silencieusement.
   */
  get cookieBase(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'strict';
    path: string;
  } {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/',
    };
  }
}
