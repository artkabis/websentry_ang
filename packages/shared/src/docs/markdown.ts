import type { DocBlock, DocInline, DocNoteTone, DocPage } from '../schemas/docs.schema.js';

/**
 * Analyseur du sous-ensemble Markdown de la documentation.
 *
 * Il ne produit AUCUN HTML : il rend des blocs et des fragments typés, que
 * l'interface dessine avec ses propres gabarits. Rendre du HTML obligerait à
 * le désinfecter, donc à tenir à jour une liste de balises admises, et à la
 * tenir juste ; une structure fermée n'a rien à désinfecter.
 *
 * Le sous-ensemble est petit À DESSEIN — titres, paragraphes, listes, blocs de
 * code, encadrés, et quatre fragments en ligne. Chaque ajout est une forme de
 * plus à dessiner dans deux thèmes et à rendre accessible : ce n'est pas
 * gratuit, et la documentation d'un outil interne n'a pas besoin de tableaux
 * imbriqués.
 *
 * Ce qui n'est pas reconnu retombe en TEXTE plutôt que de disparaître : une
 * syntaxe mal tapée doit se voir à l'écran, pas s'évaporer en silence.
 */

/** En-tête `clé: valeur` d'une page, entre deux lignes de tirets. */
export interface DocFrontMatter {
  titre: string;
  section: string;
  ordre: number;
}

const DEFAUTS: DocFrontMatter = { titre: 'Sans titre', section: 'Divers', ordre: 0 };

/**
 * Sépare l'en-tête du corps.
 *
 * Aucun analyseur YAML : l'en-tête n'a ni imbrication, ni liste, ni citation.
 * En importer un pour trois clés ferait entrer une dépendance — et sa surface —
 * pour un format qu'on maîtrise entièrement.
 */
export function separerEntete(source: string): { entete: DocFrontMatter; corps: string } {
  const lignes = source.replace(/\r\n/g, '\n').split('\n');
  if (lignes[0]?.trim() !== '---') return { entete: { ...DEFAUTS }, corps: source };

  const fin = lignes.findIndex((ligne, i) => i > 0 && ligne.trim() === '---');
  // Un en-tête ouvert et jamais refermé n'est pas un en-tête : tout le fichier
  // redevient du corps, et le défaut s'applique.
  if (fin === -1) return { entete: { ...DEFAUTS }, corps: source };

  const entete = { ...DEFAUTS };
  for (const ligne of lignes.slice(1, fin)) {
    const separateur = ligne.indexOf(':');
    if (separateur === -1) continue;
    const cle = ligne.slice(0, separateur).trim();
    const valeur = ligne.slice(separateur + 1).trim();

    if (cle === 'titre' && valeur) entete.titre = valeur;
    if (cle === 'section' && valeur) entete.section = valeur;
    if (cle === 'ordre') {
      const ordre = Number(valeur);
      if (Number.isInteger(ordre) && ordre >= 0) entete.ordre = ordre;
    }
  }

  return { entete, corps: lignes.slice(fin + 1).join('\n') };
}

/** Ancre stable dérivée d'un titre — sans accent, sans ponctuation. */
export function ancrer(texte: string): string {
  const sansAccent = texte.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ancre = sansAccent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Un titre entièrement composé de ponctuation ne doit pas produire une ancre
  // vide, que le schéma refuserait.
  return ancre === '' ? 'section' : ancre;
}

// ── Fragments en ligne ──────────────────────────────────────────────────────

/** `**fort**`, `` `code` ``, `[texte](href)` — dans cet ordre de priorité. */
const MOTIF_EN_LIGNE = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;

/**
 * Une adresse est-elle admissible ?
 *
 * Deux formes seulement : page interne, ou https. `javascript:`, `data:` et
 * les schémas exotiques ne sont pas « nettoyés » — ils ne produisent
 * simplement pas de lien, et le texte reste lisible.
 */
function adresseAdmise(href: string): boolean {
  return /^doc:[a-z0-9-]+$/.test(href) || /^https:\/\/[^\s]+$/.test(href);
}

export function analyserEnLigne(texte: string): DocInline[] {
  const fragments: DocInline[] = [];
  let curseur = 0;

  for (const trouve of texte.matchAll(MOTIF_EN_LIGNE)) {
    const debut = trouve.index;
    if (debut > curseur) {
      fragments.push({ type: 'texte', texte: texte.slice(curseur, debut) });
    }

    const [brut, fort, code] = trouve;
    if (fort) {
      fragments.push({ type: 'fort', texte: fort.slice(2, -2) });
    } else if (code) {
      fragments.push({ type: 'code', texte: code.slice(1, -1) });
    } else {
      // Le motif n'a que trois alternatives : si ce n'est ni du gras ni du
      // code, c'est un lien. Un `else if` laisserait une branche qu'aucune
      // entrée ne peut atteindre.
      const lien = trouve[3]!;
      const separation = lien.indexOf('](');
      const libelle = lien.slice(1, separation);
      const href = lien.slice(separation + 2, -1);
      // Une adresse refusée garde son texte : la syntaxe se voit, le lien non.
      if (adresseAdmise(href)) fragments.push({ type: 'lien', texte: libelle, href });
      else fragments.push({ type: 'texte', texte: brut });
    }

    curseur = debut + brut.length;
  }

  if (curseur < texte.length) fragments.push({ type: 'texte', texte: texte.slice(curseur) });
  // Un paragraphe vide n'existe pas : l'appelant ne crée pas de bloc pour lui.
  return fragments;
}

// ── Blocs ───────────────────────────────────────────────────────────────────

const TONS: Readonly<Record<string, DocNoteTone>> = {
  'note:': 'info',
  'attention:': 'avertissement',
};

/**
 * Analyse le corps d'une page en blocs.
 *
 * L'analyse est LIGNE À LIGNE, sans retour en arrière : un document mal formé
 * produit des blocs approximatifs, jamais une boucle ni une exception. Une
 * page de documentation ne doit pas pouvoir faire tomber l'API qui la sert.
 */
export function analyserBlocs(corps: string): DocBlock[] {
  const lignes = corps.replace(/\r\n/g, '\n').split('\n');
  const blocs: DocBlock[] = [];

  let i = 0;
  while (i < lignes.length) {
    // `i < lignes.length` garantit l'élément : un repli `?? ''` serait une
    // branche qu'aucune entrée ne peut atteindre, donc un test creux à écrire.
    const nettoyee = lignes[i]!.trim();

    if (nettoyee === '') {
      i += 1;
      continue;
    }

    // ── Bloc de code ─────────────────────────────────────────────────────
    if (nettoyee.startsWith('```')) {
      const langage = nettoyee.slice(3).trim() || null;
      const contenu: string[] = [];
      i += 1;
      while (i < lignes.length && !lignes[i]!.trim().startsWith('```')) {
        contenu.push(lignes[i]!);
        i += 1;
      }
      // Une clôture manquante n'est pas fatale : le bloc va jusqu'à la fin.
      i += 1;
      blocs.push({ type: 'code', langage, texte: contenu.join('\n') });
      continue;
    }

    // ── Titre ────────────────────────────────────────────────────────────
    const titre = /^(#{2,3})\s+(.*)$/.exec(nettoyee);
    if (titre) {
      // Les deux groupes existent dès que le motif a trouvé preneur.
      const niveau = titre[1]!.length === 2 ? 2 : 3;
      const texte = titre[2]!.trim();
      blocs.push({ type: 'titre', niveau, texte, ancre: ancrer(texte) });
      i += 1;
      continue;
    }

    // ── Encadré ──────────────────────────────────────────────────────────
    if (nettoyee.startsWith('> ')) {
      const lignesNote: string[] = [];
      while (i < lignes.length && lignes[i]!.trim().startsWith('> ')) {
        lignesNote.push(lignes[i]!.trim().slice(2));
        i += 1;
      }
      const brut = lignesNote.join(' ').trim();
      const marqueur = Object.keys(TONS).find(m => brut.toLowerCase().startsWith(m));
      const ton = marqueur ? TONS[marqueur]! : 'info';
      const texte = marqueur ? brut.slice(marqueur.length).trim() : brut;
      blocs.push({ type: 'note', ton, contenu: analyserEnLigne(texte) });
      continue;
    }

    // ── Liste ────────────────────────────────────────────────────────────
    const puce = /^[-*]\s+/;
    const numero = /^\d+\.\s+/;
    if (puce.test(nettoyee) || numero.test(nettoyee)) {
      const ordonnee = numero.test(nettoyee);
      const elements: DocInline[][] = [];
      while (i < lignes.length) {
        const courante = lignes[i]!.trim();
        const motif = ordonnee ? numero : puce;
        if (!motif.test(courante)) break;
        elements.push(analyserEnLigne(courante.replace(motif, '')));
        i += 1;
      }
      blocs.push({ type: 'liste', ordonnee, elements });
      continue;
    }

    // ── Paragraphe ───────────────────────────────────────────────────────
    const lignesParagraphe: string[] = [];
    while (i < lignes.length) {
      const courante = lignes[i]!.trim();
      if (
        courante === '' ||
        courante.startsWith('```') ||
        courante.startsWith('> ') ||
        /^#{2,3}\s/.test(courante) ||
        puce.test(courante) ||
        numero.test(courante)
      ) {
        break;
      }
      lignesParagraphe.push(courante);
      i += 1;
    }
    blocs.push({ type: 'paragraphe', contenu: analyserEnLigne(lignesParagraphe.join(' ')) });
  }

  return blocs;
}

/**
 * Résumé d'une page — sa première phrase.
 *
 * Il sert le sommaire, qui doit situer une page sans l'ouvrir. On prend le
 * premier paragraphe plutôt que les N premiers caractères : couper au milieu
 * d'un mot donne un sommaire qui bafouille.
 */
export function resumerBlocs(blocs: readonly DocBlock[], maximum = 180): string {
  const premier = blocs.find(b => b.type === 'paragraphe');
  if (!premier || premier.type !== 'paragraphe') return '';

  const texte = premier.contenu.map(f => f.texte).join('');
  if (texte.length <= maximum) return texte;

  const coupe = texte.slice(0, maximum);
  const espace = coupe.lastIndexOf(' ');
  return `${espace > 0 ? coupe.slice(0, espace) : coupe}…`;
}

/** Texte brut d'une page — ce que la recherche indexe. */
export function texteBrut(blocs: readonly DocBlock[]): string {
  return blocs
    .map(bloc => {
      switch (bloc.type) {
        case 'titre':
          return bloc.texte;
        case 'code':
          return bloc.texte;
        case 'paragraphe':
        case 'note':
          return bloc.contenu.map(f => f.texte).join('');
        case 'liste':
          return bloc.elements.map(e => e.map(f => f.texte).join('')).join(' ');
      }
    })
    .join('\n');
}

/** Analyse complète d'un fichier de documentation. */
export function analyserPage(slug: string, source: string): DocPage {
  const { entete, corps } = separerEntete(source);
  const blocs = analyserBlocs(corps);

  return {
    slug,
    titre: entete.titre,
    section: entete.section,
    ordre: entete.ordre,
    resume: resumerBlocs(blocs),
    blocs,
  };
}
