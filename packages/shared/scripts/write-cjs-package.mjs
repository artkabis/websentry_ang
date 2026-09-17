// Chaque dossier de sortie déclare son propre format de module : sans ces
// marqueurs, Node interpréterait les deux builds selon le `type` du package
// racine, et l'un des deux échouerait au chargement.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const write = (dir, type) =>
  writeFileSync(resolve(here, `../dist/${dir}/package.json`), `${JSON.stringify({ type }, null, 2)}\n`);

write('cjs', 'commonjs');
write('esm', 'module');
