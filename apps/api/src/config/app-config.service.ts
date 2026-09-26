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
    return this.config.get(key, { infer: true });
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

  /**
   * Politique de rétention des rapports.
   *
   * L'ordre des deux seuils est vérifié au démarrage plutôt qu'à l'exécution :
   * une purge plus précoce que la compression effacerait les rapports avant de
   * les avoir compressés, rendant la compression inutile — une erreur de
   * configuration silencieuse, qui ne se verrait que sur la facture de stockage.
   */
  get retention(): {
    enabled: boolean;
    compressAfterDays: number;
    purgeAfterDays: number;
    trashRetentionDays: number;
    batchSize: number;
  } {
    const compressAfterDays = this.get('SCAN_COMPRESS_AFTER_DAYS');
    const purgeAfterDays = this.get('SCAN_PURGE_AFTER_DAYS');
    return {
      enabled: this.get('SCAN_RETENTION_ENABLED'),
      compressAfterDays,
      purgeAfterDays,
      trashRetentionDays: this.get('SCAN_TRASH_RETENTION_DAYS'),
      batchSize: this.get('SCAN_RETENTION_BATCH'),
    };
  }

  /** Réglages du moteur d'analyse. */
  get analysis(): { workersEnabled: boolean; maxWorkers: number; batchConcurrency: number } {
    return {
      workersEnabled: this.get('ANALYSIS_WORKERS_ENABLED'),
      maxWorkers: this.get('ANALYSIS_MAX_WORKERS'),
      batchConcurrency: this.get('ANALYSIS_BATCH_CONCURRENCY'),
    };
  }

  /**
   * Politique d'anonymisation du journal d'audit.
   *
   * Elle est lue au même endroit que les autres politiques de rétention : une
   * durée de conservation qui vivrait dans le code serait une durée que
   * personne ne peut ajuster sans redéployer.
   */
  get anonymisation(): { enabled: boolean; afterDays: number; batchSize: number } {
    return {
      enabled: this.get('AUDIT_ANONYMIZE_ENABLED'),
      afterDays: this.get('AUDIT_ANONYMIZE_AFTER_DAYS'),
      batchSize: this.get('AUDIT_ANONYMIZE_BATCH'),
    };
  }

  /** Dossier des pièces jointes de la messagerie. */
  get messageUploadsDir(): string {
    return this.get('MESSAGE_UPLOADS_DIR');
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
