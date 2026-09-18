import type { ScanSort, SortOrder } from '@websentry/shared';

/**
 * Traduction des filtres de recherche en fragments SQL — fonctions PURES.
 *
 * Elles ne touchent pas la base : ce sont elles qui décident ce qui part en
 * paramètre lié et ce qui, très exceptionnellement, entre dans le texte de la
 * requête. C'est le point le plus sensible du module, donc celui qu'on isole
 * pour pouvoir le tester sans base.
 */

/** Longueur minimale d'un mot indexé par MariaDB en FULLTEXT (`innodb_ft_min_token_size`). */
export const FULLTEXT_MIN_TOKEN = 3;

/** Au-delà, la recherche libre est tronquée plutôt que refusée. */
const MAX_SEARCH_TOKENS = 8;

/**
 * Prépare un terme de recherche libre pour le mode booléen du FULLTEXT.
 *
 * MariaDB interprète `+ - > < ( ) ~ * " @` comme des OPÉRATEURS dans ce mode.
 * La v1 encadrait le terme brut de `*` sans les neutraliser, ce qui produisait
 * deux défauts :
 *   • une parenthèse non fermée saisie par l'utilisateur faisait remonter une
 *     erreur de syntaxe SQL, servie en 500 ;
 *   • le `*` de tête est inerte — MariaDB ne gère que la troncature à droite —
 *     donc la recherche « au milieu du mot » annoncée ne marchait pas.
 *
 * On retient donc les seuls caractères alphanumériques (accents compris), le
 * tiret et le point, et on suffixe chaque mot d'un `*` : « exempl » trouve
 * « exemple.fr ». Le résultat est `null` quand il ne reste rien d'indexable —
 * l'appelant retombe alors sur un `LIKE`.
 */
export function sanitizeFulltextTerm(raw: string): string | null {
  const tokens = raw
    .normalize('NFC')
    .split(/[^\p{L}\p{N}.-]+/u)
    .map(token => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(token => token.length >= FULLTEXT_MIN_TOKEN)
    .slice(0, MAX_SEARCH_TOKENS);

  if (tokens.length === 0) return null;
  return tokens.map(token => `${token}*`).join(' ');
}

/**
 * Échappe les jokers d'un motif `LIKE`.
 *
 * `%` et `_` ne sont pas une faille — la valeur reste liée — mais un utilisateur
 * saisissant `%` obtiendrait un balayage complet de la table. On les traite
 * comme des caractères littéraux, ce qui est ce qu'il voulait dire.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, match => `\\${match}`);
}

/** Motif `LIKE` « contient », jokers de l'entrée neutralisés. */
export function containsPattern(raw: string): string {
  return `%${escapeLikePattern(raw.trim())}%`;
}

/**
 * Convertit une borne de filtre en `DATETIME` UTC comparable en base.
 *
 * Deux formes arrivent ici, et elles ne veulent pas dire la même chose :
 *   • `2026-06-04` désigne un JOUR ENTIER — la borne basse est son premier
 *     instant, la borne haute son dernier ;
 *   • `2026-06-04T10:00:00Z` désigne un INSTANT — il vaut pour les deux bornes.
 *
 * La v1 concaténait ` 00:00:00` dans les deux cas. Sur un ISO complet, cela
 * produisait `2026-06-04T10:00:00Z 00:00:00` : MariaDB coerce cette chaîne en
 * silence, le filtre devenait inopérant et la recherche renvoyait tout —
 * exactement le contraire de ce que l'utilisateur avait demandé.
 *
 * Les colonnes sont stockées en UTC (`timezone: 'Z'` sur le pool) : on convertit
 * donc explicitement, sans jamais dépendre du fuseau du processus.
 */
export function toDateBound(raw: string, edge: 'start' | 'end'): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (dateOnly) {
    return edge === 'start' ? `${raw} 00:00:00` : `${raw} 23:59:59`;
  }
  // `Date` normalise le décalage horaire ; on repasse en `YYYY-MM-DD HH:MM:SS`.
  return new Date(raw).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Colonne SQL correspondant à une clé de tri.
 *
 * La correspondance est une TABLE, pas une transformation : aucune valeur venue
 * de la requête n'atteint le texte SQL. Le schéma partagé ferme déjà le jeu de
 * clés ; cette table est la seconde barrière, celle qui tiendrait même si le
 * schéma s'ouvrait un jour.
 */
const PAGE_SORT_COLUMNS: Readonly<Record<ScanSort, string>> = {
  analyzedAt: 'p.analyzed_at',
  score: 'p.global_score',
  domain: 'p.domain',
  url: 'p.url',
};

const SITE_SORT_COLUMNS: Readonly<Record<ScanSort, string>> = {
  analyzedAt: 'last_scan',
  score: 'ss.avg_score',
  domain: 'si.domain',
  // Un site n'a pas d'URL : on retombe sur le domaine, qui en est l'équivalent
  // le plus proche, plutôt que de refuser un tri que l'interface propose.
  url: 'si.domain',
};

function direction(order: SortOrder): 'ASC' | 'DESC' {
  return order === 'asc' ? 'ASC' : 'DESC';
}

/**
 * Clause `ORDER BY` d'une liste de pages.
 *
 * Le tri secondaire sur `p.id` n'est pas décoratif : sans lui, deux pages de
 * même horodatage peuvent changer de place entre deux requêtes, et la
 * pagination par OFFSET affiche alors deux fois la même ligne — ou en saute une.
 */
export function pageOrderBy(sort: ScanSort, order: SortOrder): string {
  return `ORDER BY ${PAGE_SORT_COLUMNS[sort]} ${direction(order)}, p.id ASC`;
}

/** Clause `ORDER BY` d'une liste de sites — même exigence de départage stable. */
export function siteOrderBy(sort: ScanSort, order: SortOrder): string {
  return `ORDER BY ${SITE_SORT_COLUMNS[sort]} ${direction(order)}, si.id ASC`;
}
