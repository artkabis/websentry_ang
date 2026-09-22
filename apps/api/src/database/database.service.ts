import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';

/**
 * Valeurs acceptées comme paramètres de requête.
 *
 * Type volontairement ÉTROIT : il interdit de passer un objet arbitraire (issu
 * directement d'un corps de requête, par exemple) là où le driver attend une
 * valeur scalaire — c'est ce qui rendrait possible une injection par opérateur.
 */
export type SqlParam = string | number | boolean | Date | null | Buffer;
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Accès MariaDB — pool `mysql2` exposé en provider Nest.
 *
 * TOUTE requête passe par `query()` / `queryOne()`, qui n'acceptent que du SQL
 * PARAMÉTRÉ : la signature impose de séparer le texte de la requête de ses
 * valeurs, ce qui rend l'injection SQL structurellement impossible. Aucune
 * concaténation de chaîne n'est tolérée dans les repositories (cf. tests OWASP #1).
 *
 * Le pool est optionnel (`DB_ENABLED=false`) : les tests unitaires et le mode
 * dégradé démarrent sans base.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.dbEnabled) {
      this.logger.warn('DB_ENABLED=false — démarrage sans base de données');
      return;
    }

    const db = this.config.database;
    this.pool = createPool({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      password: db.password,
      connectionLimit: db.connectionLimit,
      waitForConnections: true,
      // `namedPlaceholders` et `multipleStatements` restent DÉSACTIVÉS :
      // `multipleStatements` transformerait une injection mineure en exécution
      // de commandes enchaînées.
      multipleStatements: false,
      timezone: 'Z',
      charset: 'utf8mb4_unicode_ci',
      // Les DATETIME reviennent en chaînes : on maîtrise la conversion au lieu
      // de laisser le driver l'interpréter dans le fuseau du processus.
      dateStrings: true,
    });

    try {
      const conn = await this.pool.getConnection();
      conn.release();
      this.logger.log(`MariaDB connectée — ${db.host}:${db.port}/${db.database}`);
    } catch (err) {
      this.logger.error(`Connexion MariaDB impossible : ${(err as Error).message}`);
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  /**
   * Aller-retour minimal vers la base, et sa durée.
   *
   * Ne lève JAMAIS : une sonde qui échoue en levant transformerait un
   * composant en panne en page de supervision inaccessible — c'est-à-dire
   * qu'on perdrait la vue au moment précis où elle sert.
   *
   * `SELECT 1` plutôt qu'une requête métier : on mesure la connexion, pas le
   * plan d'exécution d'une table qui grossit.
   */
  async ping(): Promise<{ ok: boolean; latenceMs: number | null; erreur: string | null }> {
    if (!this.pool) return { ok: false, latenceMs: null, erreur: null };

    const debut = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latenceMs: Date.now() - debut, erreur: null };
    } catch (err) {
      return { ok: false, latenceMs: null, erreur: (err as Error).message };
    }
  }

  /** Accès brut au pool — réservé aux transactions. */
  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('Base de données non disponible (DB_ENABLED=false)');
    }
    return this.pool;
  }

  /**
   * Exécute une requête paramétrée et retourne les lignes.
   *
   * `params` est TOUJOURS séparé du SQL — c'est le driver qui échappe les valeurs.
   */
  async query<T extends RowDataPacket>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    const [rows] = await this.requirePool().query<T[]>(sql, [...params]);
    return rows;
  }

  /** Première ligne d'une requête paramétrée, ou `null`. */
  async queryOne<T extends RowDataPacket>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Exécute un INSERT/UPDATE/DELETE paramétré et retourne le nombre de lignes touchées. */
  async execute(sql: string, params: readonly SqlParam[] = []): Promise<number> {
    const [result] = await this.requirePool().query(sql, [...params]);
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  }

  /**
   * Exécute un bloc dans une transaction — commit au succès, rollback à la moindre
   * erreur. Indispensable à la rotation du refresh token : révoquer l'ancienne
   * session et créer la nouvelle doivent être atomiques, sinon un échec entre les
   * deux déconnecterait l'utilisateur sans recours.
   */
  async transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.requirePool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }
}
