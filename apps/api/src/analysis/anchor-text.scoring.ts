import { CATEGORIES, GENERIC_ANCHORS, STOPWORDS, SYNONYM_GROUPS } from './anchor-text.data.js';

/**
 * Concordance ancre / URL — fonctions PURES.
 *
 * Le calcul est numérique et étalonné : chaque seuil, chaque pondération a été
 * réglé sur des pages réelles. Le module est donc porté à l'IDENTIQUE depuis la
 * v1, aux garanties de type près — réécrire l'algorithme changerait les scores
 * de toutes les pages déjà auditées, sans que rien ne le signale.
 *
 * Exporté au complet : ces fonctions se testent une par une, ce qu'un calcul
 * enfoui dans un analyseur n'aurait pas permis.
 */

export { GENERIC_ANCHORS, STOPWORDS };

// ─────────────────────────────────────────────────────────────────────────────
// Pré-classifieur d'intention — intercepte avant le scoring F_β
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Motifs d'adresse postale dans le texte d'une ancre.
 * Une ancre contenant "12 rue de la Paix" ou "avenue Victor Hugo, 75001 Paris"
 * sera classée comme adresse → compatible avec les URLs de contact/localisation.
 */
const ADDRESS_ANCHOR_RE =
  /\b(rue|avenue|av\.?|boulevard|bd\.?|allée|allee|impasse|chemin|route|rte\.?|place|quai|passage|esplanade|lotissement|hameau|lieu-dit|lieudit|voie|cité|cite|square|résidence|residence|domaine|bâtiment|batiment|bat\.?)\b/i;

/** Code postal français (5 chiffres) dans une ancre */
const POSTCODE_RE = /\b\d{5}\b/;

/** Numéro de téléphone FR/international dans une ancre */
const PHONE_ANCHOR_RE = /(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/;

/** Email dans une ancre */
const EMAIL_ANCHOR_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Token à 4 chiffres correspondant à une année (filtré des segments d'URL) */
const YEAR_RE = /^(19|20)\d{2}$/;

/**
 * Segments d'URL indiquant une page de contact ou de localisation.
 * Une ancre-adresse ou ancre-téléphone pointant vers l'un de ces segments
 * est automatiquement considérée concordante.
 */
const CONTACT_LOCATION_SEGS = new Set([
  'contact',
  'contactez',
  'contacter',
  'nous-contacter',
  'contactus',
  'joindre',
  'nous-joindre',
  'ecrire',
  'nous-ecrire',
  'formulaire',
  'form',
  'adresse',
  'acces',
  'access',
  'localisation',
  'plan',
  'map',
  'itineraire',
  'coordonnees',
  'nous-trouver',
  'trouver',
  'venir',
]);

/** Retourne true si l'ancre contient une adresse postale */
export function isAddressAnchor(raw: string): boolean {
  return ADDRESS_ANCHOR_RE.test(raw) || POSTCODE_RE.test(raw);
}

/** Retourne true si l'ancre contient un numéro de téléphone */
export function isPhoneAnchor(raw: string): boolean {
  return PHONE_ANCHOR_RE.test(raw);
}

/** Retourne true si l'ancre contient une adresse email */
export function isEmailAnchor(raw: string): boolean {
  return EMAIL_ANCHOR_RE.test(raw);
}

/** Retourne true si les segments d'URL correspondent à une page contact/localisation */
export function isContactOrLocationUrl(segs: string[]): boolean {
  return segs.some(s => CONTACT_LOCATION_SEGS.has(s));
}

/**
 * Segments d'URL d'une page « à propos » / présentation de l'entreprise.
 * Une ancre = raison sociale pointant vers l'une de ces pages est concordante :
 * le nom propre n'apparaît pas dans l'URL, donc le score F_β serait nul à tort.
 */
const ABOUT_PATH_SEGS = new Set([
  'about',
  'apropos',
  'propos',
  'qui-sommes',
  'qui',
  'sommes',
  'agence',
  'presentation',
  'equipe',
  'histoire',
  'nous',
  'valeurs',
  'cabinet',
  'entreprise',
  'societe',
  'identite',
  'mission',
  'story',
  // Variantes fréquentes des pages de présentation (FR)
  'atelier',
  'studio',
  'parcours',
  'expertise',
  'savoir',
  'demarche',
  'fondateur',
  'fondatrice',
  'dirigeant',
  'maison',
]);

/** Retourne true si les segments d'URL correspondent à une page « à propos ». */
export function isAboutUrl(segs: string[]): boolean {
  return segs.some(s => ABOUT_PATH_SEGS.has(s));
}

/**
 * Tokens d'une dénomination juridique sans valeur discriminante : formes sociétaires
 * et statuts. Retirés de la raison sociale avant comparaison (« Boulangerie Martin
 * SARL » → ['boulangerie', 'martin']).
 */
const LEGAL_FORM_TOKENS = new Set([
  'sarl',
  'sarlu',
  'eurl',
  'sas',
  'sasu',
  'sa',
  'sci',
  'scic',
  'scp',
  'scm',
  'selarl',
  'selas',
  'sccv',
  'snc',
  'gie',
  'scop',
  'eirl',
  'sca',
  'association',
  'asso',
  'entreprise',
  'societe',
  'ets',
  'etablissements',
  'compagnie',
  'cie',
  'groupe',
]);

/**
 * Tokens significatifs d'une raison sociale : tokenisation standard puis retrait des
 * formes juridiques. Retourne [] si rien d'exploitable (validation désactivée).
 */
export function companyNameTokens(name: string): string[] {
  return tokenize(name).filter(t => !LEGAL_FORM_TOKENS.has(t));
}

/**
 * Vrai si TOUS les tokens significatifs de la raison sociale sont présents dans
 * l'ancre (comparaison par racine, tolère pluriel/accents). Stratégie stricte :
 * « tous les tokens » → quasi aucun faux positif.
 */
export function anchorMatchesCompany(anchorTokens: string[], companyTokens: string[]): boolean {
  if (companyTokens.length === 0) return false;
  const anchorStems = new Set(anchorTokens.map(stem));
  return companyTokens.every(ct => anchorStems.has(stem(ct)));
}

// STOPWORDS et GENERIC_ANCHORS : voir ./anchor-text.data.ts.

// ─────────────────────────────────────────────────────────────────────────────
// Segments d'URL typiques des pages boutique / e-commerce
// Utilisés par l'option excludeShopLinks pour ignorer ces liens.
// ─────────────────────────────────────────────────────────────────────────────
export const SHOP_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'shop',
  'boutique',
  'store',
  'ecommerce',
  'e-commerce',
  'produit',
  'produits',
  'product',
  'products',
  'catalogue',
  'catalog',
  'acheter',
  'buy',
  'purchase',
  'panier',
  'cart',
  'basket',
  'commande',
  'order',
  'checkout',
  'gamme',
  'collection',
  'collections',
  'references',
  'reference',
]);

// CATEGORIES et SYNONYM_GROUPS : voir ./anchor-text.data.ts (tables de données extraites).

/** Retourne le token lui-même + tous les membres de son groupe de synonymes */
export function expandedTokens(token: string): string[] {
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(token)) return group;
  }
  return [token];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fonctions utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise : minuscule, sans accents, sans ponctuation → espaces */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenise en filtrant les stopwords et les tokens trop courts */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Normalisation du pluriel français — appliquée avant la racinisation.
 *   services → service   ·   tarifs → tarif   ·   locaux → local   ·   journaux → journal
 * Garde-fou : ne touche pas aux finales -ss/-us/-os, et conserve une racine ≥ 4.
 */
export function stripPlural(w: string): string {
  const len = w.length;
  if (len >= 6 && w.endsWith('aux')) return w.slice(0, -3) + 'al';
  if (
    len >= 5 &&
    (w.endsWith('s') || w.endsWith('x')) &&
    !w.endsWith('ss') &&
    !w.endsWith('us') &&
    !w.endsWith('os') &&
    len - 1 >= 4
  ) {
    return w.slice(0, -1);
  }
  return w;
}

/**
 * Racinisation française — Snowball-FR-lite (sans dépendance externe).
 *
 * Objectif : ramener toute la famille lexicale d'un mot à une racine commune,
 * afin de détecter "aménager"/"aménagement"/"aménagements" → amenag,
 * "rénover"/"rénovation" → renov, "service"/"services" → servic, etc.
 *
 * Pipeline (sur un mot déjà normalisé : minuscule, sans accent) :
 *   1. Pluriel        — stripPlural()
 *   2. Suffixe        — suppression d'UN suffixe dérivationnel ou verbal
 *                       (le plus long d'abord), racine conservée ≥ 4 caractères
 *   3. 'e' final muet — résiduel (aménage → amenag, porte → port)
 *
 * La racinisation n'a pas besoin d'être exacte : le tier "préfixe" de
 * tokenVsSegment (0.88) rattrape les collapses imparfaits d'une même famille
 * (ex: "renovons" → renovon, préfixe-compatible avec "renov").
 */
export function stem(word: string): string {
  if (word.length < 5) return word;
  let w = stripPlural(word);

  const ts = (suffix: string): string | null =>
    w.endsWith(suffix) && w.length - suffix.length >= 4
      ? w.slice(0, w.length - suffix.length)
      : null;

  const stripped =
    // ── Suffixes longs (dérivation + verbes) ─────────────────────────────────
    ts('issements') ??
    ts('issement') ??
    ts('ification') ??
    ts('ications') ??
    ts('eraient') ??
    ts('iraient') ??
    ts('assions') ??
    ts('issons') ??
    ts('issais') ??
    ts('issait') ??
    ts('issant') ??
    ts('issent') ??
    // ── Dérivation nominale verbale ──────────────────────────────────────────
    ts('ements') ??
    ts('ement') ??
    ts('ations') ??
    ts('ation') ??
    ts('erions') ??
    ts('irions') ??
    ts('erais') ??
    ts('erait') ??
    ts('erons') ??
    ts('eront') ??
    ts('atrice') ??
    ts('ateurs') ??
    ts('ateur') ??
    ts('itudes') ??
    ts('itude') ??
    ts('aisons') ??
    ts('aison') ??
    // ── Gentilés / métiers en -ien ───────────────────────────────────────────
    ts('iennes') ??
    ts('ienne') ??
    ts('iens') ??
    ts('ien') ??
    // ── Suffixes nominaux / adjectivaux ──────────────────────────────────────
    ts('ances') ??
    ts('ance') ??
    ts('ences') ??
    ts('ence') ??
    ts('eries') ??
    ts('erie') ??
    ts('ieres') ??
    ts('iere') ??
    ts('iers') ??
    ts('ier') ??
    ts('istes') ??
    ts('iste') ??
    ts('ismes') ??
    ts('isme') ??
    ts('ables') ??
    ts('able') ??
    ts('ibles') ??
    ts('ible') ??
    ts('euses') ??
    ts('euse') ??
    ts('eurs') ??
    ts('eur') ??
    ts('tures') ??
    ts('ture') ??
    ts('ures') ??
    ts('ure') ??
    ts('tions') ??
    ts('tion') ??
    ts('sions') ??
    ts('sion') ??
    ts('ments') ??
    ts('ment') ??
    ts('iques') ??
    ts('ique') ??
    ts('ites') ??
    ts('ite') ??
    ts('eons') ??
    ts('ages') ??
    ts('age') ??
    ts('elles') ??
    ts('elle') ??
    // ── Formes adjectivales ───────────────────────────────────────────────────
    ts('ives') ??
    ts('ive') ??
    ts('ifs') ??
    ts('if') ??
    ts('antes') ??
    ts('ante') ??
    ts('ants') ??
    ts('ant') ??
    ts('aient') ??
    ts('ions') ??
    ts('iez') ??
    ts('eaux') ??
    ts('eau') ??
    ts('ales') ??
    ts('ale') ??
    ts('aux') ??
    ts('als') ??
    ts('al') ??
    // ── Désinences verbales courtes ──────────────────────────────────────────
    ts('ais') ??
    ts('ait') ??
    ts('ent') ??
    ts('ons') ??
    ts('era') ??
    ts('ira') ??
    ts('ers') ??
    ts('er') ??
    ts('irs') ??
    ts('ir') ??
    ts('ez') ??
    ts('ies') ??
    ts('ie') ??
    null;

  w = stripped ?? w;
  if (w.length >= 5 && w.endsWith('e')) w = w.slice(0, -1); // 'e' final muet
  return w;
}

/**
 * Code phonétique français léger (Soundex/Sonnex-lite) — couche de DERNIER RECOURS.
 *
 * Normalise uniquement les équivalences de CONSONNES et les lettres muettes,
 * en conservant les voyelles (pour ne pas confondre "jardin"/"jardon",
 * "salon"/"selon"). Détecte les variantes orthographiques que Levenshtein rate :
 *   esthetique ↔ esthetik   ·   photographe ↔ fotograf   ·   classique ↔ klassik
 *
 * Transformations : ph→f, ch→x(ʃ), qu/q→k, c(e|i|y)→s sinon c→k, g(e|i|y)→j,
 * h muet supprimé, w→v, y→i, doublons écrasés, 'e' final muet retiré.
 */
export function phonetic(w: string): string {
  let s = w
    .replace(/x/g, 'ks') // vrai x (taxi) avant le marqueur ch→x
    .replace(/ch/g, 'x')
    .replace(/ph/g, 'f')
    .replace(/qu/g, 'k')
    .replace(/q/g, 'k')
    .replace(/c([eiy])/g, 's$1')
    .replace(/c/g, 'k')
    .replace(/g([eiy])/g, 'j$1')
    .replace(/h/g, '')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
  if (s.length >= 5 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/**
 * Normalise un segment brut d'URL en tokens filtrés.
 * - Sépare le camelCase : "NosServices" → ["nos", "services"]
 * - Filtre les UUIDs hex, les années (2000–2030), les stopwords et < 3 chars
 */
export function splitUrlSegment(raw: string): string[] {
  return (
    raw
      // camelCase : "NosServices" → "Nos-Services"
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .split(/[-_]/)
      .map(s => normalize(s))
      .filter(
        s =>
          s.length >= 3 &&
          !STOPWORDS.has(s) &&
          !YEAR_RE.test(s) && // filtre "2024", "2025", etc.
          !/^[0-9a-f]{8,}$/.test(s) && // filtre UUIDs hexadécimaux Duda
          !/^\d+$/.test(s), // filtre segments purement numériques
      )
  );
}

/** Extrait les segments significatifs du chemin d'un href */
export function hrefSegments(href: string, pageUrl: string): string[] {
  try {
    const url = new URL(href, pageUrl);

    const pathSegs = url.pathname.split('/').flatMap(seg => splitUrlSegment(seg));

    // Fragment (#hash) — nom de section ou de marque dans l'URL
    const hashRaw = url.hash.replace(/^#/, '');
    if (!hashRaw) return pathSegs;

    const hashSegs = hashRaw
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .split(/[-_]/)
      .map(s => normalize(s))
      .filter(s => s.length >= 3 && !STOPWORDS.has(s));

    return [...pathSegs, ...hashSegs];
  } catch {
    return [];
  }
}

/**
 * Distance de Levenshtein, O(m·n).
 *
 * Les deux lignes de travail sont des `Uint32Array` et non des tableaux :
 * l'indexation y rend un `number`, jamais `number | undefined`. L'invariant
 * « l'indice est dans les bornes » est ainsi porté par le TYPE, au lieu de
 * gardes d'exécution qui ne pourraient jamais se déclencher — donc de branches
 * impossibles à tester honnêtement.
 *
 * Au-delà de trente caractères, on rend l'écart de longueur : c'est une borne
 * basse de la distance réelle, et la comparaison exacte n'apporterait rien sur
 * des mots aussi longs.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 30 || b.length > 30) return Math.abs(a.length - b.length);

  const width = b.length + 1;
  let previous = new Uint32Array(width);
  let current = new Uint32Array(width);
  for (let column = 0; column < width; column += 1) previous[column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    // Les trois valeurs voisines sont portées par des SCALAIRES : la diagonale
    // et la gauche se déduisent de l'itération précédente, si bien qu'un seul
    // accès indexé subsiste par case. `?? 0` n'y couvre aucun cas réel —
    // `column` reste borné par `width` — mais le coût en est nul et la boucle
    // reste lisible.
    let diagonal = previous[0] ?? 0;
    let left = row;
    current[0] = row;

    for (let column = 1; column < width; column += 1) {
      const above = previous[column] ?? 0;
      const cost = a[row - 1] === b[column - 1] ? diagonal : 1 + Math.min(above, left, diagonal);
      current[column] = cost;
      diagonal = above;
      left = cost;
    }

    [previous, current] = [current, previous];
  }

  return previous[b.length] ?? 0;
}

/**
 * Score de concordance d'un token contre un segment d'URL.
 *
 * Ordre d'évaluation (du plus fiable au dernier recours) :
 *  1. Égalité exacte → 1.0
 *  2. Racines identiques (stemmer FR) → 0.95  (amenager ↔ amenagements)
 *  3. Racine de l'un préfixe de l'autre (≥ 5 chars) → 0.88
 *  4. Préfixe commun normalisé (≥ 4 chars)
 *  5. Levenshtein normalisé (seuil 0.55)
 *  6. Phonétique FR (dernier recours, plafonné à 0.80) — variantes orthographiques
 */
export function tokenVsSegment(token: string, seg: string): number {
  if (token === seg) return 1.0;

  // Comparaison morphologique par racine
  const stemT = stem(token);
  const stemS = stem(seg);
  if (stemT === stemS && stemT.length >= 4) return 0.95;
  if (
    stemT.length >= 5 &&
    stemS.length >= 5 &&
    (stemT.startsWith(stemS) || stemS.startsWith(stemT))
  )
    return 0.88;

  // Préfixe commun — uniquement significatif si ≥ 4 caractères
  let ci = 0;
  while (ci < token.length && ci < seg.length && token[ci] === seg[ci]) ci++;
  const prefixScore = ci >= 4 ? ci / Math.max(token.length, seg.length) : 0;
  // Levenshtein normalisé
  const dist = levenshtein(token, seg);
  const levScore = 1 - dist / Math.max(token.length, seg.length, 1);
  const morph = Math.max(prefixScore, levScore > 0.55 ? levScore : 0);
  if (morph >= 0.8) return morph;

  // Dernier recours : équivalence phonétique (variantes/fautes d'orthographe).
  // Plafonné à 0.80 → ne peut jamais déclencher seul la promotion concordant (≥ 0.9).
  if (token.length >= 5 && seg.length >= 5) {
    const pt = phonetic(token);
    if (pt.length >= 4 && pt === phonetic(seg)) return Math.max(morph, 0.8);
  }
  return morph;
}

/**
 * Score max du meilleur token (et ses synonymes) vs le meilleur segment.
 * Étape 1 : matching morphologique (Levenshtein + préfixe).
 * Étape 2 : si le token appartient à un groupe de synonymes, tous les membres
 *           sont également testés → détecte "bassin" ↔ "piscine", "demandez" ↔ "contact", etc.
 */
export function bestTokenScore(token: string, segs: string[]): number {
  const candidates = expandedTokens(token);
  let best = 0;
  for (const t of candidates) {
    for (const seg of segs) {
      const s = tokenVsSegment(t, seg);
      if (s > best) best = s;
      if (best === 1.0) return 1.0;
    }
  }
  return best;
}

/**
 * Score F_β (β=0.5) — remplace le MAX pur pour éviter les faux concordants.
 *
 * ─── Pourquoi F_β plutôt que MAX ? ────────────────────────────────────────────
 * MAX = "un seul token suffit" → "Voir nos devis de plomberie" → /devis-peinture
 * obtient MAX=100% car "devis" matche, mais "plomberie" ≠ "peinture".
 * F_β exige que TOUS les tokens de l'ancre contribuent au score global.
 *
 * ─── Formules ─────────────────────────────────────────────────────────────────
 *
 * Précision P (ancre → URL) :
 *   Pour chaque token t de l'ancre, quel est son meilleur match dans les segments ?
 *   Pondéré par la longueur du token (longueur = proxy de spécificité sémantique).
 *
 *   P = Σ(|t| · bestTokenScore(t, S)) / Σ|t|
 *
 * Rappel R (URL → ancre) :
 *   Pour chaque segment s de l'URL, est-il couvert par les tokens de l'ancre
 *   (après expansion synonymes) ?
 *
 *   R = (1/|S|) · Σ_s max_{t' ∈ expand(T)} sim(t', s)
 *
 * F_β avec β=0.5 (précision 4× plus importante que le rappel) :
 *   → Reflète la direction SEO : "l'ancre décrit-elle la destination ?"
 *
 *   F_β = (1+β²)·P·R / (β²·P + R) = 1.25·P·R / (0.25P + R)
 *
 * Score final = max(F_β, catBonus)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function computeFBetaScore(
  tokens: string[],
  segs: string[],
): { fBeta: number; precision: number; recall: number } {
  if (tokens.length === 0 || segs.length === 0) {
    return { fBeta: 0, precision: 0, recall: 0 };
  }

  // ── Précision pondérée par longueur ( spécificité du token ) ──────────────
  let weightedSum = 0;
  let totalWeight = 0;
  for (const t of tokens) {
    const w = Math.min(t.length, 10); // plafond 10 pour éviter l'écrasement par très longs tokens
    weightedSum += w * bestTokenScore(t, segs);
    totalWeight += w;
  }
  const precision = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // ── Rappel : couverture des segments d'URL par les tokens + leurs synonymes ─
  const allExpandedTokens = tokens.flatMap(t => expandedTokens(t));
  let recallSum = 0;
  for (const seg of segs) {
    let bestSeg = 0;
    for (const t of allExpandedTokens) {
      const s = tokenVsSegment(t, seg);
      if (s > bestSeg) bestSeg = s;
      if (bestSeg === 1.0) break;
    }
    recallSum += bestSeg;
  }
  const recall = recallSum / segs.length;

  // ── F_β avec β = 0.5 ───────────────────────────────────────────────────────
  const BETA_SQ = 0.25; // β² = 0.5² = 0.25 → précision ×4 vs rappel
  const denom = BETA_SQ * precision + recall;
  const fBeta = denom > 0 ? ((1 + BETA_SQ) * precision * recall) / denom : 0;

  return { fBeta, precision, recall };
}

/**
 * Bonus catégorie : 0.85 si ancre et href appartiennent à la même catégorie thématique.
 *
 * Règle de correspondance :
 * - Égalité exacte → toujours valide
 * - Préfixe commun → uniquement si ≥ 4 caractères (évite "car" → "carriere", "pro" → "produit")
 * - Priorité au token de l'ancre sur le mot de catégorie (la catégorie peut être plus large)
 *
 * Note : les mots de catégorie peuvent être multi-mots ("prendre contact") — on compare
 * uniquement les tokens individuels (après normalize) pour rester cohérent avec le pipeline.
 */
export function categoryBonus(tokens: string[], segs: string[]): number {
  const MIN_PREFIX = 4; // préfixe minimum pour autoriser startsWith
  for (const cat of CATEGORIES) {
    const anchorHit = tokens.some(t =>
      cat.words.some(w => {
        if (w === t) return true;
        // Préfixe uniquement si les deux côtés ont ≥ MIN_PREFIX chars
        if (t.length >= MIN_PREFIX && w.length >= MIN_PREFIX) {
          if (w.startsWith(t) || t.startsWith(w)) return true;
        }
        return false;
      }),
    );
    if (!anchorHit) continue;
    const hrefHit = segs.some(s =>
      cat.paths.some(p => {
        if (p === s) return true;
        if (s.length >= MIN_PREFIX && p.length >= MIN_PREFIX) {
          if (p.startsWith(s) || s.startsWith(p)) return true;
        }
        return false;
      }),
    );
    if (hrefHit) return 0.85;
  }
  return 0;
}

/**
 * Vérifie si un href pointe vers la boutique en utilisant le chemin Duda réel.
 * Supprime le préfixe /site/UUID (mode preview) avant comparaison.
 * Ex: href=/site/abc123.../boutique/produit + shopBasePath=/boutique → true
 */
export function isShopLink(href: string, pageUrl: string, shopBasePath: string): boolean {
  try {
    const url = new URL(href, pageUrl);
    // Supprime le préfixe Duda preview /site/{UUID} du chemin du lien
    const cleanPath = url.pathname.replace(/^\/site\/[0-9a-f]{8,}/, '') || '/';
    // Supprime aussi le préfixe /site/{UUID} du shopBasePath lui-même
    // (window.Parameters.StorePath = '/site/{uuid}/boutique' en prepub, '/boutique' en live)
    const cleanBase = shopBasePath.replace(/^\/site\/[0-9a-f]{8,}/, '') || '/';
    // Seules les sous-pages (/boutique/produit-xxx, /boutique/categorie-xxx…) sont exclues.
    // La page principale de la boutique (/boutique) est conservée dans l'analyse.
    const base = cleanBase.endsWith('/') ? cleanBase : cleanBase + '/';
    return cleanPath.startsWith(base);
  } catch {
    return false;
  }
}
