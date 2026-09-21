// Mise en route de la base — schéma et premier compte.
//
// Il n'existe AUCUN moyen de se connecter sans identifiant, et il n'en existera
// pas : un accès sans preuve d'identité serait un contournement
// d'authentification, pas une commodité de développement. Ce script crée donc
// un vrai compte, avec un vrai mot de passe, haché par le même service que
// celui qui vérifiera la connexion.
//
//   node scripts/db.mjs init
//   node scripts/db.mjs user <identifiant> <mot de passe> [rang]
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { ENV_FILES } from './env-files.mjs';
import { decouperSql, lireEnv, lireRang } from './db-helpers.mjs';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function environnement() {
  for (const chemin of ENV_FILES) {
    const absolu = resolve(racine, chemin);
    if (existsSync(absolu)) return { ...lireEnv(readFileSync(absolu, 'utf8')), ...process.env };
  }
  console.error('Aucun fichier d’environnement trouvé. Emplacements cherchés :');
  for (const chemin of ENV_FILES) console.error(`  - ${resolve(racine, chemin)}`);
  process.exit(1);
}

async function connecter(env) {
  return mysql.createConnection({
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER ?? 'websentry',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME ?? 'websentry',
    multipleStatements: false,
  });
}

async function init(connexion) {
  const dossier = join(racine, 'src/database/sql');
  // L'ordre alphabétique EST l'ordre de dépendance : les fichiers sont
  // numérotés, et `users` doit exister avant ce qui la référence.
  const fichiers = readdirSync(dossier)
    .filter(nom => nom.endsWith('.sql'))
    .sort();

  for (const fichier of fichiers) {
    const instructions = decouperSql(readFileSync(join(dossier, fichier), 'utf8'));
    for (const instruction of instructions) await connexion.query(instruction);
    console.log(`  ${fichier} — ${instructions.length} instruction(s)`);
  }
}

async function creerCompte(connexion, [identifiant, motDePasse, rang]) {
  if (!identifiant || !motDePasse) {
    console.error('Usage : node scripts/db.mjs user <identifiant> <mot de passe> [rang]');
    process.exit(1);
  }

  const compile = join(racine, 'dist/security/password.service.js');
  if (!existsSync(compile)) {
    console.error('Le service de mot de passe n’est pas compilé.');
    console.error('Lancez d’abord : pnpm --filter @websentry/api build');
    process.exit(1);
  }
  const { PasswordService } = await import(compile);

  const hash = await new PasswordService().hash(motDePasse);
  // Rejouer la commande RÉINITIALISE le mot de passe — c'est le geste attendu
  // quand on l'a oublié. `token_version` est incrémenté du même coup : les
  // sessions ouvertes avec l'ancien mot de passe cessent d'être valables.
  await connexion.query(
    `INSERT INTO users (id, username, password_hash, rank, status)
     VALUES (?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       rank          = VALUES(rank),
       status        = 'active',
       failed_logins = 0,
       locked_until  = NULL,
       token_version = token_version + 1`,
    [randomUUID(), identifiant, hash, lireRang(rang)],
  );
}

const [commande, ...arguments_] = process.argv.slice(2);
const env = environnement();
const connexion = await connecter(env);

try {
  if (commande === 'init') {
    console.log('Application du schéma :');
    await init(connexion);
    console.log('Schéma à jour.');
  } else if (commande === 'user') {
    await creerCompte(connexion, arguments_);
    console.log(`Compte « ${arguments_[0]} » prêt (rang ${lireRang(arguments_[2])}).`);
  } else {
    console.error('Commandes : init | user <identifiant> <mot de passe> [rang]');
    process.exitCode = 1;
  }
} finally {
  await connexion.end();
}
