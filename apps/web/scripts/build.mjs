#!/usr/bin/env node
/**
 * Build du frontend, puis contrôle du chargement initial.
 *
 * Le contrôle tourne MÊME quand `ng build` a échoué, dès lors qu'un rapport
 * existe. La raison est concrète : un budget dépassé s'annonce « 34,56 kio de
 * trop » et s'arrête là. Avec `&&`, le contrôle qui sait NOMMER la cause ne
 * serait jamais atteint, et le développeur repartirait chercher à la main ce
 * que l'outil pouvait lui dire.
 *
 * Le code de sortie est le pire des deux : ni le build ni le contrôle ne peut
 * être couvert par l'autre.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { exit } from 'node:process';

const STATS = 'dist/stats.json';

const build = spawnSync('ng', ['build'], { stdio: 'inherit', shell: true });
const codeBuild = build.status ?? 1;

if (!existsSync(STATS)) {
  // Build réussi sans rapport : le contrôle n'a rien pu vérifier, et se taire
  // équivaudrait à valider. Build échoué : l'erreur du build suffit, elle est
  // déjà affichée.
  if (codeBuild === 0) {
    console.error(`\n✘ ${STATS} absent : le contrôle du chargement initial n'a rien vérifié.`);
    console.error("  Vérifier l'option « statsJson » de la configuration de production.\n");
    exit(1);
  }
  exit(codeBuild);
}

const controle = spawnSync('node', ['scripts/verifier-noyau.mjs', STATS], { stdio: 'inherit' });
exit(Math.max(codeBuild, controle.status ?? 1));
