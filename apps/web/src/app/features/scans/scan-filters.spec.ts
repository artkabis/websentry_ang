import { describe, expect, it } from 'vitest';
import {
  ariaSortOf,
  EMPTY_FILTERS,
  filterIssues,
  filtersFromParams,
  filtersToQuery,
  hasActiveFilters,
  paramsFromFilters,
  toggleSort,
  type ScanFilterState,
} from './scan-filters';

const filters = (over: Partial<ScanFilterState> = {}): ScanFilterState => ({
  ...EMPTY_FILTERS,
  ...over,
});

describe('filtersFromParams', () => {
  it('rend les valeurs par défaut sans paramètre', () => {
    expect(filtersFromParams({})).toEqual(EMPTY_FILTERS);
  });

  it('lit les filtres textuels en les élaguant', () => {
    const result = filtersFromParams({ q: '  exemple  ', domain: 'exemple.fr', epj: 'ABC' });
    expect(result).toMatchObject({ q: 'exemple', domain: 'exemple.fr', epj: 'ABC' });
  });

  it('lit un intervalle de score', () => {
    expect(filtersFromParams({ scoreMin: '2.5', scoreMax: '5' })).toMatchObject({
      scoreMin: 2.5,
      scoreMax: 5,
    });
  });

  it.each(['abc', '-1', '9', ''])('IGNORE un score illisible (%s)', raw => {
    // Une URL saisie à la main ou tronquée par un partage ne doit pas produire
    // un 400 pour un lien que l'utilisateur n'a pas composé.
    expect(filtersFromParams({ scoreMin: raw }).scoreMin).toBeNull();
  });

  it.each(['04/06/2026', '2026-6-4', 'hier'])('IGNORE une date mal formée (%s)', raw => {
    expect(filtersFromParams({ dateFrom: raw }).dateFrom).toBe('');
  });

  it('accepte une date ISO', () => {
    expect(filtersFromParams({ dateFrom: '2026-06-04' }).dateFrom).toBe('2026-06-04');
  });

  it('RETOMBE sur le tri par défaut quand la colonne est inconnue', () => {
    // L'URL peut venir d'une version antérieure de l'interface, qui proposait
    // d'autres colonnes.
    expect(filtersFromParams({ sort: 'inventee' })).toMatchObject({
      sort: 'analyzedAt',
      order: 'desc',
    });
  });

  it('accepte un tri connu', () => {
    expect(filtersFromParams({ sort: 'score', order: 'asc' })).toMatchObject({
      sort: 'score',
      order: 'asc',
    });
  });

  it.each(['0', '-3', 'deux', ''])('ramène une page invalide (%s) à 1', raw => {
    expect(filtersFromParams({ page: raw }).page).toBe(1);
  });

  it('lit une page valide', () => {
    expect(filtersFromParams({ page: '4' }).page).toBe(4);
  });

  it('tolère une valeur absente', () => {
    expect(filtersFromParams({ q: undefined, domain: null }).q).toBe('');
  });
});

describe('paramsFromFilters', () => {
  it('OMET les valeurs par défaut', () => {
    // Sans quoi l'URL d'une recherche vierge serait couverte de paramètres, et
    // deux états identiques produiraient deux adresses différentes.
    expect(paramsFromFilters(EMPTY_FILTERS)).toEqual({});
  });

  it('écrit les filtres renseignés', () => {
    const result = paramsFromFilters(
      filters({ q: 'exemple', gamme: 'premium', scoreMin: 3, dateFrom: '2026-06-01', page: 2 }),
    );
    expect(result).toEqual({
      q: 'exemple',
      gamme: 'premium',
      scoreMin: '3',
      dateFrom: '2026-06-01',
      page: '2',
    });
  });

  it('écrit un score nul, qui est une valeur et non une absence', () => {
    expect(paramsFromFilters(filters({ scoreMin: 0 }))).toEqual({ scoreMin: '0' });
  });

  it('fait un aller-retour fidèle', () => {
    const original = filters({
      q: 'exemple',
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: 'ABC',
      scoreMin: 2,
      scoreMax: 4,
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      sort: 'score',
      order: 'asc',
      page: 3,
    });
    expect(filtersFromParams(paramsFromFilters(original))).toEqual(original);
  });
});

describe('filtersToQuery', () => {
  it('transmet toujours pagination et tri', () => {
    expect(filtersToQuery(EMPTY_FILTERS, 20)).toEqual({
      page: 1,
      limit: 20,
      sort: 'analyzedAt',
      order: 'desc',
    });
  });

  it('n’envoie QUE les filtres renseignés', () => {
    // Un `gamme=` vide n'exprime aucun filtre : l'envoyer transformerait
    // « pas de filtre » en « filtre sur la chaîne vide ».
    const query = filtersToQuery(filters({ gamme: '', domain: 'exemple.fr' }), 20);
    expect(query['gamme']).toBeUndefined();
    expect(query['domain']).toBe('exemple.fr');
  });

  it('transmet les bornes de score et de date', () => {
    const query = filtersToQuery(
      filters({ q: 'x', epj: 'ABC', scoreMin: 1, scoreMax: 4, dateFrom: 'a', dateTo: 'b' }),
      50,
    );
    expect(query).toMatchObject({
      q: 'x',
      epj: 'ABC',
      scoreMin: 1,
      scoreMax: 4,
      dateFrom: 'a',
      dateTo: 'b',
    });
  });
});

describe('hasActiveFilters', () => {
  it('est faux sur un état vierge', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('ignore le tri et la page — ce ne sont pas des filtres', () => {
    expect(hasActiveFilters(filters({ sort: 'score', order: 'asc', page: 5 }))).toBe(false);
  });

  it.each([
    ['q', { q: 'x' }],
    ['domain', { domain: 'x' }],
    ['gamme', { gamme: 'x' }],
    ['epj', { epj: 'x' }],
    ['scoreMin', { scoreMin: 1 }],
    ['scoreMax', { scoreMax: 1 }],
    ['dateFrom', { dateFrom: '2026-06-01' }],
    ['dateTo', { dateTo: '2026-06-01' }],
  ])('est vrai dès que %s est posé', (_label, over) => {
    expect(hasActiveFilters(filters(over))).toBe(true);
  });
});

describe('filterIssues', () => {
  it('ne signale rien sur un état cohérent', () => {
    expect(filterIssues(filters({ scoreMin: 1, scoreMax: 4 }))).toEqual([]);
  });

  it('signale un intervalle de score inversé', () => {
    expect(filterIssues(filters({ scoreMin: 4, scoreMax: 1 }))).toHaveLength(1);
  });

  it('signale un intervalle de dates inversé', () => {
    expect(filterIssues(filters({ dateFrom: '2026-06-30', dateTo: '2026-06-01' }))).toHaveLength(1);
  });

  it('accepte des bornes égales', () => {
    expect(
      filterIssues(
        filters({ scoreMin: 3, scoreMax: 3, dateFrom: '2026-06-01', dateTo: '2026-06-01' }),
      ),
    ).toEqual([]);
  });

  it('cumule les incohérences', () => {
    expect(
      filterIssues(
        filters({ scoreMin: 4, scoreMax: 1, dateFrom: '2026-06-30', dateTo: '2026-06-01' }),
      ),
    ).toHaveLength(2);
  });
});

describe('toggleSort', () => {
  it('INVERSE le sens sur une colonne déjà triée', () => {
    expect(toggleSort(filters({ sort: 'score', order: 'desc' }), 'score')).toMatchObject({
      sort: 'score',
      order: 'asc',
    });
  });

  it('repart du sens naturel sur une autre colonne', () => {
    // Décroissant pour un score (« les pires d'abord »), croissant pour un
    // texte : c'est ce que l'utilisateur attend du premier clic.
    expect(toggleSort(EMPTY_FILTERS, 'score').order).toBe('desc');
    expect(toggleSort(EMPTY_FILTERS, 'domain').order).toBe('asc');
    expect(toggleSort(EMPTY_FILTERS, 'url').order).toBe('asc');
  });

  it('RAMÈNE en première page', () => {
    // Rester page 4 afficherait un extrait arbitraire du nouveau classement.
    expect(toggleSort(filters({ page: 4 }), 'score').page).toBe(1);
    expect(toggleSort(filters({ page: 4, sort: 'score' }), 'score').page).toBe(1);
  });

  it('préserve les filtres', () => {
    expect(toggleSort(filters({ domain: 'exemple.fr' }), 'score').domain).toBe('exemple.fr');
  });
});

describe('ariaSortOf', () => {
  it('annonce le sens de la colonne triée', () => {
    expect(ariaSortOf(filters({ sort: 'score', order: 'asc' }), 'score')).toBe('ascending');
    expect(ariaSortOf(filters({ sort: 'score', order: 'desc' }), 'score')).toBe('descending');
  });

  it('annonce « none » sur les autres colonnes', () => {
    expect(ariaSortOf(filters({ sort: 'score' }), 'domain')).toBe('none');
  });
});
