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

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sortie = resolve(racine, 'dist/main.js');

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
