// Serveur de développement de l'API.
//
// Pourquoi un script plutôt qu'une ligne de `package.json` : le code source
// importe ses modules avec l'extension `.js` (convention NodeNext, exigée par
// TypeScript), et le dépouillement de types natif de Node NE RÉSOUT PAS un
// spécificateur `.js` vers le fichier `.ts` correspondant. Exécuter les sources
// directement échoue donc dès le premier import, quelle que soit la version de
// Node.
//
// Un exécuteur tiers (tsx, esbuild) ne convient pas davantage : Nest injecte
// ses dépendances PAR TYPE, ce qui exige `emitDecoratorMetadata` — qu'esbuild
// n'implémente pas. Sans lui, chaque `constructor(private x: Service)` reçoit
// `undefined`. C'est la même raison qui fait passer les tests par SWC.
//
// On compile donc avec `tsc`, seul à produire ces métadonnées, et on relance le
// serveur à chaque écriture. Deux processus, aucune dépendance de plus, et le
// même comportement sous Windows, macOS et Linux.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_FILES } from './env-files.mjs';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sortie = resolve(racine, 'dist/main.js');

// Dire OÙ le fichier d'environnement est cherché, avant que le serveur ne
// tombe sur « JWT_SECRET manquant ». Sans ces chemins, l'erreur est exacte mais
// muette sur sa cause la plus fréquente : un .env au mauvais endroit, ou nommé
// `.env.txt` par un explorateur qui masque les extensions connues.
const trouves = ENV_FILES.map(chemin => resolve(racine, chemin)).filter(existsSync);
if (trouves.length === 0) {
  console.warn('\nAucun fichier d’environnement trouvé. Emplacements cherchés :');
  for (const chemin of ENV_FILES) console.warn(`  - ${resolve(racine, chemin)}`);
  console.warn('Copiez .env.example en .env à la racine du dépôt, puis renseignez JWT_SECRET.\n');
} else {
  console.log(`Environnement lu depuis : ${trouves.join(', ')}`);
}

/** Lance une commande en héritant des flux — les journaux restent lisibles. */
const lancer = (commande, args) =>
  spawn(commande, args, { cwd: racine, stdio: 'inherit', shell: process.platform === 'win32' });

const compilateur = lancer('tsc', ['-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']);

// Le serveur attend la PREMIÈRE compilation : démarrer avant que `dist/` existe
// afficherait une erreur de module introuvable à chaque clone neuf, ce qui est
// exactement ce que ce script existe pour éviter.
let serveur = null;
const attendre = setInterval(() => {
  if (!existsSync(sortie)) return;
  clearInterval(attendre);
  serveur = lancer(process.execPath, ['--watch', '--enable-source-maps', sortie]);
  serveur.on('exit', code => {
    if (code !== 0 && code !== null) process.exitCode = code;
  });
}, 300);

const arreter = () => {
  clearInterval(attendre);
  compilateur.kill();
  serveur?.kill();
};
process.on('SIGINT', arreter);
process.on('SIGTERM', arreter);
compilateur.on('exit', arreter);
