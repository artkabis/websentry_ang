import { describe, expect, it } from 'vitest';
import {
  FULLTEXT_MIN_TOKEN,
  containsPattern,
  escapeLikePattern,
  pageOrderBy,
  sanitizeFulltextTerm,
  siteOrderBy,
  toDateBound,
} from './scan-query.util.js';

describe('sanitizeFulltextTerm', () => {
  it('suffixe chaque mot d’un joker de troncature', () => {
    expect(sanitizeFulltextTerm('exemple site')).toBe('exemple* site*');
  });

  it.each(['+', '>', '<', '(', ')', '~', '*', '"', '@'])(
    'ÉLIMINE l’opérateur booléen %s de la requête',
    operator => {
      // En mode booléen, MariaDB interprète ces caractères. La v1 les laissait
      // passer : une parenthèse non fermée saisie par l'utilisateur remontait
      // une erreur de syntaxe SQL, servie en 500.
      const result = sanitizeFulltextTerm(`exemple${operator}site`);
      expect(result).toBe('exemple* site*');
    },
  );

  it.each(['-', '+', '~', '<', '>', '*'])('n’émet jamais de mot COMMENÇANT par %s', operator => {
    // C'est la position qui fait l'opérateur : `-exemple` exclut le terme,
    // `mon-site` ne veut rien dire de particulier. On élague donc les bords
    // sans mutiler les domaines à tiret.
    const result = sanitizeFulltextTerm(`${operator}exemple`);
    expect(result).toBe('exemple*');
  });

  it('garde le tiret INTERNE, qui appartient au nom de domaine', () => {
    expect(sanitizeFulltextTerm('mon-site')).toBe('mon-site*');
  });

  it('ne produit jamais de joker de tête — MariaDB ne tronque qu’à droite', () => {
    // La v1 encadrait le terme de `*` des deux côtés, laissant croire à une
    // recherche « au milieu du mot » qui n'a jamais fonctionné.
    const result = sanitizeFulltextTerm('exemple');
    expect(result?.startsWith('*')).toBe(false);
  });

  it('conserve les lettres accentuées', () => {
    expect(sanitizeFulltextTerm('hôtel')).toBe('hôtel*');
  });

  it('conserve le point et le tiret internes d’un domaine', () => {
    expect(sanitizeFulltextTerm('mon-site.fr')).toBe('mon-site.fr*');
  });

  it('élague la ponctuation de bord', () => {
    expect(sanitizeFulltextTerm('.exemple.')).toBe('exemple*');
  });

  it.each(['fr', 'a', '42', '', '   ', '+++', '...'])(
    'rend null pour « %s », trop court pour l’index',
    term => {
      // L'appelant retombe alors sur un LIKE : refuser laisserait croire
      // qu'aucun site ne correspond.
      expect(sanitizeFulltextTerm(term)).toBeNull();
    },
  );

  it('borne le nombre de mots retenus', () => {
    const many = Array.from({ length: 30 }, (_, i) => `mot${i}`).join(' ');
    expect(sanitizeFulltextTerm(many)?.split(' ')).toHaveLength(8);
  });

  it('expose le seuil de l’index', () => {
    expect(FULLTEXT_MIN_TOKEN).toBe(3);
  });
});

describe('escapeLikePattern', () => {
  it.each([
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['c:\\temp', 'c:\\\\temp'],
  ])('échappe %s', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  it('laisse un texte ordinaire intact', () => {
    expect(escapeLikePattern('exemple.fr')).toBe('exemple.fr');
  });
});

describe('containsPattern', () => {
  it('encadre le motif et neutralise les jokers de l’entrée', () => {
    // Sans échappement, saisir « % » déclencherait un balayage complet de la
    // table — ce que l'utilisateur ne demandait pas.
    expect(containsPattern(' 50% ')).toBe('%50\\%%');
  });
});

describe('toDateBound', () => {
  it('étend une date seule au jour entier', () => {
    expect(toDateBound('2026-06-04', 'start')).toBe('2026-06-04 00:00:00');
    expect(toDateBound('2026-06-04', 'end')).toBe('2026-06-04 23:59:59');
  });

  it('respecte un instant ISO des deux côtés de l’intervalle', () => {
    expect(toDateBound('2026-06-04T10:00:00Z', 'start')).toBe('2026-06-04 10:00:00');
    expect(toDateBound('2026-06-04T10:00:00Z', 'end')).toBe('2026-06-04 10:00:00');
  });

  it('CONVERTIT le décalage horaire au lieu de le concaténer', () => {
    // C'est le défaut de la v1 : ` 00:00:00` collé derrière un ISO complet
    // produisait une chaîne que MariaDB coerce en silence, rendant le filtre
    // inopérant — la recherche renvoyait alors TOUT.
    expect(toDateBound('2026-06-04T12:00:00+02:00', 'start')).toBe('2026-06-04 10:00:00');
  });

  it('ne dépend pas du fuseau du processus', () => {
    const before = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      expect(toDateBound('2026-06-04T10:00:00Z', 'start')).toBe('2026-06-04 10:00:00');
    } finally {
      process.env.TZ = before;
    }
  });
});

describe('pageOrderBy', () => {
  it.each([
    ['analyzedAt', 'p.analyzed_at'],
    ['score', 'p.global_score'],
    ['domain', 'p.domain'],
    ['url', 'p.url'],
  ] as const)('traduit le tri %s en colonne', (sort, column) => {
    expect(pageOrderBy(sort, 'desc')).toContain(`${column} DESC`);
  });

  it('honore le sens croissant', () => {
    expect(pageOrderBy('score', 'asc')).toContain('p.global_score ASC');
  });

  it('DÉPARTAGE toujours par identifiant', () => {
    // Sans départage stable, deux pages de même horodatage changent de place
    // entre deux requêtes : la pagination par OFFSET affiche alors deux fois la
    // même ligne, ou en saute une.
    expect(pageOrderBy('analyzedAt', 'desc')).toContain('p.id ASC');
  });

  it('n’injecte jamais la valeur reçue dans le SQL', () => {
    const clause = pageOrderBy('analyzedAt', 'desc');
    expect(clause).toBe('ORDER BY p.analyzed_at DESC, p.id ASC');
  });
});

describe('siteOrderBy', () => {
  it('trie par date de dernier scan', () => {
    expect(siteOrderBy('analyzedAt', 'desc')).toContain('last_scan DESC');
  });

  it('retombe sur le domaine pour un tri par URL — un site n’en a pas', () => {
    expect(siteOrderBy('url', 'asc')).toContain('si.domain ASC');
  });

  it('départage par identifiant de site', () => {
    expect(siteOrderBy('score', 'desc')).toContain('si.id ASC');
  });
});
