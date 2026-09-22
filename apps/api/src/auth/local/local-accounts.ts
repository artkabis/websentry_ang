import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as z from 'zod';

/**
 * Comptes locaux — le mode « sans base » de la v1.
 *
 * La v1 permettait de travailler avec un compte `admin` et un compte `tester`
 * sans MariaDB. La v2 l'avait perdu : l'authentification lit la table `users`,
 * et `DB_ENABLED=false` laissait donc une application impossible à ouvrir.
 *
 * Ce n'est PAS un contournement d'authentification. Les comptes ont un vrai mot
 * de passe, haché par le même service que celui qui vérifie la connexion ; seul
 * le lieu de stockage change — un fichier, au lieu d'une table. Ce qui est
 * interdit reste interdit : rang, statut, verrouillage et révocation
 * s'appliquent comme en base.
 *
 * Le fichier n'est JAMAIS versionné, et le mode entier est refusé en
 * production (cf. `env.schema.ts`).
 */

/** Rangs de la v1, repris tels quels. */
export const LOCAL_ADMIN_RANK = 50;
export const LOCAL_TESTER_RANK = 10;

export const LocalAccountSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1).max(64),
    /** Format `<sel_hex>:<empreinte_hex>` — jamais un mot de passe en clair. */
    passwordHash: z.string().regex(/^[0-9a-f]+:[0-9a-f]+$/, 'Empreinte de mot de passe invalide'),
    rank: z.union([z.literal(10), z.literal(30), z.literal(50), z.literal(100)]),
    status: z.enum(['active', 'suspended', 'pending']).default('active'),
    tokenVersion: z.number().int().min(0).default(0),
    failedLogins: z.number().int().min(0).default(0),
    lockedUntil: z.string().nullable().default(null),
  })
  .strict();

export type LocalAccount = z.infer<typeof LocalAccountSchema>;

export const LocalAccountsFileSchema = z
  .object({
    /** Version de format — un fichier d'une autre version est refusé, pas deviné. */
    version: z.literal(1),
    accounts: z.array(LocalAccountSchema).max(100),
  })
  .strict();

export type LocalAccountsFile = z.infer<typeof LocalAccountsFileSchema>;

/** Emplacement du fichier, relatif au répertoire courant (`apps/api`). */
export const LOCAL_ACCOUNTS_PATH = '.dev-accounts.json';

export function accountsFilePath(cwd = process.cwd()): string {
  return resolve(cwd, LOCAL_ACCOUNTS_PATH);
}

/**
 * Lit le fichier, ou rend un contenu vide s'il n'existe pas.
 *
 * Un fichier ILLISIBLE lève, au lieu d'être silencieusement remplacé par un
 * contenu vide : effacer sans le dire les comptes de quelqu'un parce qu'une
 * accolade manque serait pire que refuser de démarrer.
 */
export function readAccounts(chemin: string): LocalAccountsFile {
  if (!existsSync(chemin)) return { version: 1, accounts: [] };

  const brut: unknown = JSON.parse(readFileSync(chemin, 'utf8'));
  const lu = LocalAccountsFileSchema.safeParse(brut);
  if (!lu.success) {
    throw new Error(
      `Fichier de comptes locaux illisible (${chemin}) : ${lu.error.issues
        .map(issue => `${issue.path.join('.')} — ${issue.message}`)
        .join(', ')}`,
    );
  }
  return lu.data;
}

export function writeAccounts(chemin: string, fichier: LocalAccountsFile): void {
  mkdirSync(dirname(chemin), { recursive: true });
  // Droits restreints au propriétaire : le fichier porte des empreintes de mots
  // de passe, même si elles ne sont pas réversibles.
  writeFileSync(chemin, `${JSON.stringify(fichier, null, 2)}\n`, { mode: 0o600 });
}

/** Mot de passe initial — aléatoire, jamais une valeur prévisible. */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

/** Ajoute ou remplace un compte, en conservant son identifiant s'il existe. */
export function upsertAccount(
  fichier: LocalAccountsFile,
  compte: { username: string; passwordHash: string; rank: LocalAccount['rank'] },
): LocalAccountsFile {
  const existant = fichier.accounts.find(item => item.username === compte.username);

  const suivant: LocalAccount = {
    id: existant?.id ?? randomUUID(),
    username: compte.username,
    passwordHash: compte.passwordHash,
    rank: compte.rank,
    status: 'active',
    // Changer le mot de passe INVALIDE les sessions ouvertes avec l'ancien,
    // exactement comme la commande équivalente côté base.
    tokenVersion: (existant?.tokenVersion ?? 0) + (existant ? 1 : 0),
    failedLogins: 0,
    lockedUntil: null,
  };

  return {
    version: 1,
    accounts: [...fichier.accounts.filter(item => item.username !== compte.username), suivant],
  };
}
