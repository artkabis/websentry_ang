// Change le mot de passe d'un compte LOCAL (mode sans base).
//
//   node scripts/dev-user.mjs <identifiant> <mot de passe> [rang]
//
// L'équivalent avec MariaDB est `scripts/db.mjs user`. Les deux hachent par le
// service compilé du projet : reproduire scrypt et ses paramètres ailleurs
// créerait deux vérités, dont l'une dériverait.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lireRang } from './db-helpers.mjs';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [identifiant, motDePasse, rang] = process.argv.slice(2);

if (!identifiant || !motDePasse) {
  console.error('Usage : pnpm --filter @websentry/api dev:user <identifiant> <mot de passe> [rang]');
  process.exit(1);
}

const compile = join(racine, 'dist');
if (!existsSync(join(compile, 'security/password.service.js'))) {
  console.error('Le code n’est pas compilé. Lancez : pnpm --filter @websentry/api build');
  process.exit(1);
}

const { PasswordService } = await import(join(compile, 'security/password.service.js'));
const comptes = await import(join(compile, 'auth/local/local-accounts.js'));

const chemin = comptes.accountsFilePath(racine);
const fichier = comptes.readAccounts(chemin);
const misAJour = comptes.upsertAccount(fichier, {
  username: identifiant,
  passwordHash: await new PasswordService().hash(motDePasse),
  rank: lireRang(rang),
});
comptes.writeAccounts(chemin, misAJour);

console.log(`Compte local « ${identifiant} » prêt (rang ${lireRang(rang)}) — ${chemin}`);
