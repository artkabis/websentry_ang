#!/usr/bin/env node
/**
 * Contrôle du CHARGEMENT INITIAL — étape bloquante du build.
 *
 * Un budget en kio dit qu'on a grossi ; il ne dit pas de quoi ni par quelle
 * faute. Ce contrôle dit l'inverse : il nomme le paquet entré dans le noyau et
 * la chaîne d'import qui l'y a traîné, et il échoue.
 *
 * Il existe parce que le cas s'est produit : une fonction de trois lignes
 * importée d'un module qui contenait aussi des schémas Zod a épinglé 124,9 kio
 * de validateur au premier octet servi, pendant six modules, sans que rien
 * d'autre qu'un avertissement de taille ne le signale.
 *
 * Il porte AUSSI le plafond de taille, et ce n'est pas un doublon du budget
 * d'Angular : quand ce budget échoue, le constructeur n'écrit pas de rapport,
 * et le contrôle qui sait nommer la cause ne tourne jamais. Le budget d'Angular
 * reste donc un avertissement précoce ; la porte bloquante est ici, où le
 * chiffre et la cause s'affichent ensemble.
 *
 * Usage : node scripts/verifier-noyau.mjs [chemin/vers/stats.json]
 */
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

/**
 * Paquets INTERDITS sur le chemin de démarrage, et pourquoi.
 *
 * Un paquet listé ici n'est pas interdit dans l'application : il est interdit
 * dans le morceau que le navigateur télécharge AVANT la première navigation.
 */
/**
 * Plafond du JAVASCRIPT initial, en kio.
 *
 * Mesuré à 304,96 kio après le retrait du client de requêtes et le report du
 * validateur ; le plafond laisse environ 8 % au-dessus. Il ne couvre pas la
 * feuille de style : ce qu'un graphe d'import décide, c'est le JavaScript, et
 * une régression CSS se corrige ailleurs (cf. DECISIONS 68).
 */
const PLAFOND_JS_KIO = 330;

const INTERDITS = {
  zod: 'Le validateur pèse ~125 kio et 22,5 kio de sa conversion JSON Schema ne sont pas élaguables. Les schémas se chargent par sous-chemin dynamique, depuis le code qui valide (cf. DECISIONS 68).',
};

/** Nom du paquet npm auquel appartient un fichier, ou `null` pour du code local. */
export function paquetDe(chemin) {
  const pnpm = /node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(chemin);
  if (pnpm) return pnpm[1];
  const plat = /node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(chemin);
  return plat ? plat[1] : null;
}

/**
 * Les morceaux téléchargés avant toute navigation : les entrées, plus la
 * fermeture de leurs imports STATIQUES. Un `import()` dynamique ouvre au
 * contraire un morceau différé — c'est tout l'intérêt.
 */
export function chunksInitiaux(sorties) {
  const racines = Object.keys(sorties).filter(n => /(^|\/)(main|polyfills)-/.test(n));
  const vus = new Set();
  const descendre = nom => {
    if (vus.has(nom) || !sorties[nom]) return;
    vus.add(nom);
    for (const imp of sorties[nom].imports ?? []) {
      if (imp.kind === 'import-statement') descendre(imp.path);
    }
  };
  racines.forEach(descendre);
  return vus;
}

/** Octets du noyau, groupés par paquet (ou par `apps/web` pour le code local). */
export function poidsParPaquet(sorties, initiaux) {
  const total = new Map();
  for (const chunk of initiaux) {
    for (const [entree, info] of Object.entries(sorties[chunk]?.inputs ?? {})) {
      const cle =
        paquetDe(entree) ?? (entree.includes('packages/shared') ? '@websentry/shared' : 'apps/web');
      total.set(cle, (total.get(cle) ?? 0) + info.bytesInOutput);
    }
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * La plus courte chaîne d'import qui amène le paquet fautif dans le noyau.
 *
 * Le parcours part des fichiers DU PAQUET présents dans le noyau et remonte,
 * parce que c'est le sens qui répond à la question posée : « quelle ligne de
 * notre code faut-il retirer ? ». Il remonte jusqu'à un fichier de `src/` —
 * l'application elle-même, seul endroit où une ligne d'import s'enlève. Un
 * ancêtre resté dans un morceau différé ne dirait rien de ce chargement-ci :
 * la chaîne ne retient que ce qui est réellement livré.
 *
 * Les re-exports intermédiaires (un baril qui ne pèse aucun octet) restent
 * dans la chaîne : ils font partie du chemin réel, et les masquer rendrait le
 * diagnostic incompréhensible.
 */
export function chaineVers(entrees, presents, paquet) {
  const arrivees = [...presents].filter(p => paquetDe(p) === paquet);
  if (arrivees.length === 0) return null;

  const inverse = new Map();
  for (const [source, info] of Object.entries(entrees)) {
    for (const imp of info.imports ?? []) {
      if (!inverse.has(imp.path)) inverse.set(imp.path, []);
      inverse.get(imp.path).push(source);
    }
  }

  const enfant = new Map(arrivees.map(p => [p, null]));
  const file = [...arrivees];
  while (file.length > 0) {
    const ici = file.shift();
    if (ici.startsWith('src/') && presents.has(ici)) {
      const chaine = [];
      for (let n = ici; n !== null && n !== undefined; n = enfant.get(n)) chaine.push(n);
      return chaine;
    }
    for (const parent of inverse.get(ici) ?? []) {
      if (!enfant.has(parent)) {
        enfant.set(parent, ici);
        file.push(parent);
      }
    }
  }
  return null;
}

export function verifier(stats, interdits = INTERDITS, plafondKio = PLAFOND_JS_KIO) {
  const initiaux = chunksInitiaux(stats.outputs);
  const presents = new Set();
  for (const c of initiaux)
    for (const e of Object.keys(stats.outputs[c]?.inputs ?? {})) presents.add(e);

  const poids = poidsParPaquet(stats.outputs, initiaux);
  const octets = poids.reduce((s, [, b]) => s + b, 0);
  const fautes = poids
    .filter(([nom]) => nom in interdits)
    .map(([nom, b]) => ({
      paquet: nom,
      octets: b,
      raison: interdits[nom],
      chaine: chaineVers(stats.inputs, presents, nom),
    }));

  // La taille RÉELLEMENT servie, et non la somme des sources attribuées : ce
  // sont les octets du fichier livré, après minification.
  const jsInitial = [...initiaux].reduce((somme, c) => somme + (stats.outputs[c]?.bytes ?? 0), 0);
  const plafond = plafondKio * 1024;

  return {
    initiaux: [...initiaux],
    poids,
    octets,
    fautes,
    jsInitial,
    plafond,
    tropGros: jsInitial > plafond,
  };
}

const kio = o => `${(o / 1024).toFixed(1)} kio`;

function principal() {
  const chemin = argv[2] ?? 'dist/stats.json';
  let stats;
  try {
    stats = JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (err) {
    // Un stats.json absent veut dire que le build ne l'a pas produit : le
    // contrôle n'a rien vérifié, et se taire équivaudrait à valider.
    console.error(`✘ Contrôle du noyau impossible : ${chemin} illisible (${err.message}).`);
    exit(1);
  }

  const { poids, octets, fautes, jsInitial, plafond, tropGros } = verifier(stats);

  console.log(
    `\nJavaScript initial — ${kio(jsInitial)} livrés (plafond ${kio(plafond)}), ` +
      `${kio(octets)} de sources réparties sur ${poids.length} paquets :`,
  );
  for (const [nom, b] of poids.slice(0, 12)) {
    console.log(
      `  ${kio(b).padStart(10)}  ${((100 * b) / octets).toFixed(1).padStart(5)} %  ${nom}`,
    );
  }

  if (fautes.length === 0 && !tropGros) {
    console.log('\n✔ Aucun paquet interdit, et le plafond est tenu.\n');
    return;
  }

  if (tropGros) {
    console.error(
      `\n✘ Le JavaScript initial pèse ${kio(jsInitial)}, au-dessus du plafond de ${kio(plafond)}.`,
    );
    console.error(
      '  Le tableau ci-dessus dit quel paquet a grossi. Un écran se charge par route ;\n' +
        '  ce qui pèse ici est atteint AVANT la première navigation.\n',
    );
  }

  for (const f of fautes) {
    console.error(`\n✘ « ${f.paquet} » est dans le chargement initial (${kio(f.octets)}).`);
    console.error(`  ${f.raison}`);
    if (f.chaine) {
      console.error('  Chaîne d’import :');
      f.chaine.forEach((p, i) => console.error(`    ${'  '.repeat(i)}${i > 0 ? '└─ ' : ''}${p}`));
    }
  }
  console.error('');
  exit(1);
}

// Exécuté en script, pas quand un test importe les fonctions ci-dessus.
if (argv[1]?.endsWith('verifier-noyau.mjs')) principal();
