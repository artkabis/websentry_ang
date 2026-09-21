// Chaque dossier de sortie déclare son propre format de module : sans ces
// marqueurs, Node interpréterait les deux builds selon le `type` du package
// racine, et l'un des deux échouerait au chargement.
//
// Ces fichiers portent aussi `sideEffects` : un bundler cherche la déclaration
// dans le package.json le PLUS PROCHE du fichier résolu — ici celui du dossier
// de sortie, pas celui du paquet. Sans elle, tout ce que le barillet réexporte
// est réputé impur, donc conservé et chargé d'emblée : le catalogue des
// vingt-neuf critères se retrouvait dans le chargement initial alors que seuls
// des écrans différés le lisent.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const write = (dir, type) =>
  writeFileSync(
    resolve(here, `../dist/${dir}/package.json`),
    `${JSON.stringify({ type, sideEffects: false }, null, 2)}\n`,
  );

write('cjs', 'commonjs');
write('esm', 'module');
