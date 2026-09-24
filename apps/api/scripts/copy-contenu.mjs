import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copie les pages de documentation dans la sortie de compilation.
 *
 * `tsc` ne copie que ce qu'il compile : les fichiers Markdown resteraient dans
 * `src/`, et le portail servirait un sommaire VIDE en production sans que rien
 * n'échoue — le service se contente de journaliser et de repartir. Le défaut
 * ne se verrait donc qu'à l'écran, une fois déployé.
 *
 * Le script ÉCHOUE si la source est absente : un build qui produit une
 * documentation vide doit s'arrêter, pas se terminer en silence.
 */
const ici = dirname(fileURLToPath(import.meta.url));
const source = join(ici, '..', 'src', 'docs', 'contenu');
const cible = join(ici, '..', 'dist', 'docs', 'contenu');

if (!existsSync(source)) {
  console.error(`Documentation introuvable : ${source}`);
  process.exit(1);
}

cpSync(source, cible, { recursive: true });
console.log(`Documentation copiée vers ${cible}`);
