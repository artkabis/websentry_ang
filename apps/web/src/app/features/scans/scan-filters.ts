import {
  DEFAULT_PAGE_SIZE,
  ScanSortSchema,
  SortOrderSchema,
  type ScanSort,
  type SortOrder,
} from '@websentry/shared';

/**
 * Filtres de l'historique et leur reflet dans l'URL — fonctions PURES.
 *
 * L'état de recherche vit dans la barre d'adresse et non dans le composant :
 * une recherche devient alors partageable, remise en favori, et survit à un
 * rechargement. C'est aussi ce qui rend le bouton « Précédent » du navigateur
 * cohérent avec ce que l'utilisateur vient de faire.
 */

export interface ScanFilterState {
  q: string;
  domain: string;
  gamme: string;
  epj: string;
  scoreMin: number | null;
  scoreMax: number | null;
  dateFrom: string;
  dateTo: string;
  sort: ScanSort;
  order: SortOrder;
  page: number;
}

export const EMPTY_FILTERS: ScanFilterState = {
  q: '',
  domain: '',
  gamme: '',
  epj: '',
  scoreMin: null,
  scoreMax: null,
  dateFrom: '',
  dateTo: '',
  sort: 'analyzedAt',
  order: 'desc',
  page: 1,
};

/** Valeur de paramètre telle qu'Angular la rend : absente, unique ou répétée. */
type ParamValue = string | undefined | null;

function text(raw: ParamValue): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Nombre borné à l'échelle des scores.
 *
 * Une valeur illisible dans l'URL — saisie à la main, tronquée par un partage —
 * est IGNORÉE plutôt que transmise : le backend la refuserait en 400, et
 * l'utilisateur verrait une erreur pour un lien qu'il n'a pas composé.
 */
function score(raw: ParamValue): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  return value;
}

/** Date `AAAA-MM-JJ` uniquement — l'interface n'expose pas d'horodatage complet. */
function isoDate(raw: ParamValue): string {
  const value = text(raw);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function pageNumber(raw: ParamValue): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Lit l'état de recherche depuis les paramètres d'URL. */
export function filtersFromParams(params: Record<string, ParamValue>): ScanFilterState {
  const sort = ScanSortSchema.safeParse(params['sort']);
  const order = SortOrderSchema.safeParse(params['order']);

  return {
    q: text(params['q']),
    domain: text(params['domain']),
    gamme: text(params['gamme']),
    epj: text(params['epj']),
    scoreMin: score(params['scoreMin']),
    scoreMax: score(params['scoreMax']),
    dateFrom: isoDate(params['dateFrom']),
    dateTo: isoDate(params['dateTo']),
    // Un tri inconnu retombe sur le défaut : l'URL peut venir d'une version
    // antérieure de l'interface, qui proposait d'autres colonnes.
    sort: sort.success ? sort.data : EMPTY_FILTERS.sort,
    order: order.success ? order.data : EMPTY_FILTERS.order,
    page: pageNumber(params['page']),
  };
}

/**
 * Écrit l'état dans des paramètres d'URL.
 *
 * Les valeurs par défaut sont OMISES : l'URL d'une recherche vierge reste
 * propre, et deux états identiques produisent exactement la même adresse — sans
 * quoi l'historique du navigateur se remplirait de doublons.
 */
export function paramsFromFilters(filters: ScanFilterState): Record<string, string> {
  const params: Record<string, string> = {};

  if (filters.q) params['q'] = filters.q;
  if (filters.domain) params['domain'] = filters.domain;
  if (filters.gamme) params['gamme'] = filters.gamme;
  if (filters.epj) params['epj'] = filters.epj;
  if (filters.scoreMin !== null) params['scoreMin'] = String(filters.scoreMin);
  if (filters.scoreMax !== null) params['scoreMax'] = String(filters.scoreMax);
  if (filters.dateFrom) params['dateFrom'] = filters.dateFrom;
  if (filters.dateTo) params['dateTo'] = filters.dateTo;
  if (filters.sort !== EMPTY_FILTERS.sort) params['sort'] = filters.sort;
  if (filters.order !== EMPTY_FILTERS.order) params['order'] = filters.order;
  if (filters.page !== 1) params['page'] = String(filters.page);

  return params;
}

/** Filtres prêts pour l'appel API — seules les valeurs renseignées sont transmises. */
export function filtersToQuery(
  filters: ScanFilterState,
  limit = DEFAULT_PAGE_SIZE,
): Record<string, string | number> {
  const query: Record<string, string | number> = {
    page: filters.page,
    limit,
    sort: filters.sort,
    order: filters.order,
  };

  if (filters.q) query['q'] = filters.q;
  if (filters.domain) query['domain'] = filters.domain;
  if (filters.gamme) query['gamme'] = filters.gamme;
  if (filters.epj) query['epj'] = filters.epj;
  if (filters.scoreMin !== null) query['scoreMin'] = filters.scoreMin;
  if (filters.scoreMax !== null) query['scoreMax'] = filters.scoreMax;
  if (filters.dateFrom) query['dateFrom'] = filters.dateFrom;
  if (filters.dateTo) query['dateTo'] = filters.dateTo;

  return query;
}

/** Vrai si au moins un filtre est posé — pilote l'affichage « réinitialiser ». */
export function hasActiveFilters(filters: ScanFilterState): boolean {
  return (
    filters.q !== '' ||
    filters.domain !== '' ||
    filters.gamme !== '' ||
    filters.epj !== '' ||
    filters.scoreMin !== null ||
    filters.scoreMax !== null ||
    filters.dateFrom !== '' ||
    filters.dateTo !== ''
  );
}

/**
 * Incohérences détectées AVANT l'appel réseau.
 *
 * Le backend les refuserait en 400, mais le dire ici évite un aller-retour et
 * place le message à côté du champ fautif plutôt qu'en haut de l'écran.
 */
export function filterIssues(filters: ScanFilterState): string[] {
  const issues: string[] = [];

  if (
    filters.scoreMin !== null &&
    filters.scoreMax !== null &&
    filters.scoreMin > filters.scoreMax
  ) {
    issues.push('Le score minimum dépasse le score maximum.');
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    issues.push('La date de début est postérieure à la date de fin.');
  }

  return issues;
}

/**
 * Bascule le tri sur une colonne.
 *
 * Cliquer une colonne déjà triée INVERSE le sens ; cliquer une autre colonne
 * repart du sens le plus utile pour elle — décroissant pour une date ou un
 * score (« les plus récents », « les pires » d'abord), croissant pour un texte.
 * Le retour à la première page est indispensable : rester page 4 après un
 * changement de tri afficherait un extrait arbitraire du nouveau classement.
 */
export function toggleSort(filters: ScanFilterState, column: ScanSort): ScanFilterState {
  if (filters.sort === column) {
    return { ...filters, order: filters.order === 'asc' ? 'desc' : 'asc', page: 1 };
  }
  const naturalOrder: SortOrder = column === 'domain' || column === 'url' ? 'asc' : 'desc';
  return { ...filters, sort: column, order: naturalOrder, page: 1 };
}

/** Libellé ARIA du sens de tri d'une colonne, pour `aria-sort`. */
export function ariaSortOf(
  filters: ScanFilterState,
  column: ScanSort,
): 'ascending' | 'descending' | 'none' {
  if (filters.sort !== column) return 'none';
  return filters.order === 'asc' ? 'ascending' : 'descending';
}
