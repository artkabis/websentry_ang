// Fonctions pures des scripts de base — testables sans base de données.

/** Rangs acceptés par la contrainte `chk_rank` de la table `users`. */
export const RANGS = { tester: 10, editor: 30, admin: 50, super_admin: 100 };

/**
 * Découpe un fichier SQL en instructions.
 *
 * Les commentaires en ligne sont retirés d'abord : un `;` à l'intérieur de
 * l'un d'eux couperait une instruction en deux morceaux invalides. Les schémas
 * du projet ne contiennent ni procédure ni déclencheur, donc aucun `DELIMITER`
 * à gérer — si cela changeait, ce découpage devrait l'être aussi.
 */
export function decouperSql(sql) {
  return sql
    .split('\n')
    .map(ligne => ligne.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(instruction => instruction.trim())
    .filter(instruction => instruction.length > 0);
}

/**
 * Lit un fichier d'environnement.
 *
 * Écrit ici plutôt qu'emprunté à `dotenv` : celui-ci n'est qu'une dépendance
 * TRANSITIVE de `@nestjs/config`, et pnpm ne la rend pas résoluble depuis nos
 * scripts. En dépendre marcherait aujourd'hui et casserait au premier ménage
 * dans l'arbre de dépendances.
 */
export function lireEnv(texte) {
  const valeurs = {};
  for (const ligne of texte.split('\n')) {
    const nette = ligne.trim();
    if (!nette || nette.startsWith('#')) continue;
    const separateur = nette.indexOf('=');
    if (separateur <= 0) continue;
    const cle = nette.slice(0, separateur).trim();
    const brut = nette.slice(separateur + 1).trim();
    valeurs[cle] = brut.replace(/^(['"])(.*)\1$/, '$2');
  }
  return valeurs;
}

/** Traduit un rang écrit en toutes lettres ou en chiffres, ou lève. */
export function lireRang(valeur) {
  if (valeur === undefined) return RANGS.admin;
  const nombre = Number(valeur);
  if (Object.values(RANGS).includes(nombre)) return nombre;
  const nomme = RANGS[String(valeur).toLowerCase()];
  if (nomme !== undefined) return nomme;
  throw new Error(
    `Rang inconnu : « ${valeur} ». Attendu ${Object.entries(RANGS)
      .map(([nom, rang]) => `${nom} (${rang})`)
      .join(', ')}.`,
  );
}
