import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
// Le MÊME découpeur que le script de mise en route : si le schéma ne s'applique
// que parce que le test le découpe autrement, le test ne prouve rien du script
// que l'exploitant lancera.
// @ts-expect-error — outillage en JavaScript simple, hors du programme
// TypeScript : ces scripts s'exécutent avant toute compilation.
import { decouperSql } from '../../scripts/db-helpers.mjs';
import type { AppConfigService } from '../../src/config/app-config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';

/**
 * Harnais des tests d'intégration MariaDB.
 *
 * Ces suites existent pour une raison précise : jusqu'ici, TOUT le SQL du
 * projet n'était exercé que contre des doubles. Or les doubles reproduisent ce
 * qu'on a compris du moteur, pas ce que le moteur fait — et le SQL en jeu
 * (fonction fenêtre, recherche plein texte booléenne, colonne générée,
 * `UPDATE … ORDER BY … LIMIT`, verrouillage optimiste) est précisément celui
 * dont le comportement varie d'un moteur et d'une version à l'autre.
 *
 * Elles ne tournent PAS dans `pnpm test` : elles demandent une base. Elles ont
 * leur propre commande, que la CI lance avec un service MariaDB. Et elles
 * ÉCHOUENT si la base manque, au lieu de se déclarer ignorées — une suite qui
 * s'auto-dispense de tourner ne garantit rien, et le silence passerait pour un
 * succès.
 */

const RACINE_API = resolve(import.meta.dirname, '../..');

export interface ReglagesBase {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Lit la configuration de la base de test.
 *
 * Un nom de base DISTINCT est exigé : ces suites vident les tables à chaque
 * fichier, et pointer par accident sur une base de développement la détruirait.
 */
export function reglages(): ReglagesBase {
  const env = process.env;
  const database = env.INTEGRATION_DB_NAME ?? '';

  if (!database) {
    throw new Error(
      'INTEGRATION_DB_NAME est absent : les tests d’intégration n’ont pas de base. ' +
        'Lancer une MariaDB, puis : INTEGRATION_DB_NAME=websentry_test pnpm --filter @websentry/api test:integration',
    );
  }

  if (!/test/i.test(database)) {
    throw new Error(
      `Refus de travailler sur « ${database} » : ces suites VIDENT les tables. ` +
        'Le nom de la base d’intégration doit contenir « test ».',
    );
  }

  return {
    host: env.INTEGRATION_DB_HOST ?? '127.0.0.1',
    port: Number(env.INTEGRATION_DB_PORT ?? 3306),
    database,
    user: env.INTEGRATION_DB_USER ?? 'websentry',
    password: env.INTEGRATION_DB_PASSWORD ?? '',
  };
}

/** Un vrai `DatabaseService`, branché sur la base de test. */
export async function ouvrir(): Promise<DatabaseService> {
  const r = reglages();
  const config = {
    dbEnabled: true,
    database: { ...r, connectionLimit: 5 },
  } as AppConfigService;

  const db = new DatabaseService(config);
  await db.onModuleInit();
  return db;
}

/**
 * Applique le schéma du dépôt sur une base vide.
 *
 * Les tables sont supprimées d'abord, et par une requête qui les DÉCOUVRE : une
 * liste écrite à la main oublierait la prochaine table ajoutée, et la suite
 * tournerait sur un reste de la précédente.
 */
export async function appliquerSchema(db: DatabaseService): Promise<void> {
  const r = reglages();
  const tables = await db.query<RowDataPacket & { nom: string }>(
    'SELECT table_name AS nom FROM information_schema.tables WHERE table_schema = ?',
    [r.database],
  );

  if (tables.length > 0) {
    await db.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const { nom } of tables) {
      // Le nom vient d'information_schema, pas d'une entrée utilisateur ; il est
      // néanmoins encadré, parce qu'un identifiant ne se paramètre pas en SQL.
      await db.execute(`DROP TABLE IF EXISTS \`${nom.replace(/`/g, '')}\``);
    }
    await db.execute('SET FOREIGN_KEY_CHECKS = 1');
  }

  const dossier = join(RACINE_API, 'src/database/sql');
  for (const fichier of readdirSync(dossier)
    .filter(nom => nom.endsWith('.sql'))
    .sort()) {
    for (const instruction of decouperSql(readFileSync(join(dossier, fichier), 'utf8'))) {
      await db.execute(instruction);
    }
  }
}

/** Vide les tables entre deux tests, sans redéfaire le schéma. */
export async function viderTables(db: DatabaseService): Promise<void> {
  const r = reglages();
  const tables = await db.query<RowDataPacket & { nom: string }>(
    'SELECT table_name AS nom FROM information_schema.tables WHERE table_schema = ?',
    [r.database],
  );

  await db.execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const { nom } of tables) {
    await db.execute(`TRUNCATE TABLE \`${nom.replace(/`/g, '')}\``);
  }
  await db.execute('SET FOREIGN_KEY_CHECKS = 1');
}

/** Un compte, parce que presque toute table du schéma en référence un. */
export async function compte(
  db: DatabaseService,
  id: string,
  options: { username?: string; rank?: number } = {},
): Promise<string> {
  await db.execute(
    `INSERT INTO users (id, username, password_hash, rank, status)
     VALUES (?, ?, '$argon2id$v=19$m=1,t=1,p=1$c2VsZHVwb2l2cmU$aaaa', ?, 'active')`,
    [id, options.username ?? `compte-${id.slice(0, 8)}`, options.rank ?? 50],
  );
  return id;
}
