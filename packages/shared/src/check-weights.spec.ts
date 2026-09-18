import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECK_WEIGHT,
  MAX_CHECK_WEIGHT,
  MIN_CHECK_WEIGHT,
  WEIGHT_TIERS,
  resolveCheckWeight,
  tierForWeight,
  weightedGlobalScore,
} from './check-weights.js';

describe('WEIGHT_TIERS', () => {
  it('va du plus au moins influent', () => {
    const factors = WEIGHT_TIERS.map(t => t.factor);
    expect(factors).toEqual([...factors].sort((a, b) => b - a));
  });

  it('contient un palier neutre égal au poids par défaut', () => {
    // Sans lui, il serait impossible de revenir au comportement d'origine en un clic.
    expect(WEIGHT_TIERS.find(t => t.id === 'normal')?.factor).toBe(DEFAULT_CHECK_WEIGHT);
  });

  it('reste dans l’échelle autorisée', () => {
    for (const tier of WEIGHT_TIERS) {
      expect(tier.factor).toBeGreaterThanOrEqual(MIN_CHECK_WEIGHT);
      expect(tier.factor).toBeLessThanOrEqual(MAX_CHECK_WEIGHT);
    }
  });
});

describe('tierForWeight', () => {
  it.each(WEIGHT_TIERS.map(t => [t.factor, t.id] as const))(
    'retrouve le palier du coefficient %s',
    (factor, id) => {
      expect(tierForWeight(factor)?.id).toBe(id);
    },
  );

  it('rend null pour une valeur intermédiaire — la surcharge fine n’est pas un palier', () => {
    expect(tierForWeight(1.25)).toBeNull();
    expect(tierForWeight(3)).toBeNull();
  });
});

describe('resolveCheckWeight', () => {
  it('rend le poids par défaut sans réglages', () => {
    expect(resolveCheckWeight('METAS')).toBe(DEFAULT_CHECK_WEIGHT);
    expect(resolveCheckWeight('METAS', null)).toBe(DEFAULT_CHECK_WEIGHT);
    expect(resolveCheckWeight('METAS', {})).toBe(DEFAULT_CHECK_WEIGHT);
  });

  it('rend 0 pour un critère en mode indicatif', () => {
    // Le mode indicatif l'emporte : c'est ce qui unifie l'exclusion du score
    // entre le backend et l'affichage.
    expect(resolveCheckWeight('METAS', { informationalChecks: ['METAS'] })).toBe(0);
  });

  it('fait primer le mode indicatif sur une surcharge de poids', () => {
    const weight = resolveCheckWeight('METAS', {
      informationalChecks: ['METAS'],
      checkWeights: { METAS: 5 },
    });
    expect(weight).toBe(0);
  });

  it('applique une surcharge explicite', () => {
    expect(resolveCheckWeight('METAS', { checkWeights: { METAS: 2 } })).toBe(2);
  });

  it('borne une surcharge hors échelle au lieu de la propager', () => {
    expect(resolveCheckWeight('METAS', { checkWeights: { METAS: 99 } })).toBe(MAX_CHECK_WEIGHT);
    expect(resolveCheckWeight('METAS', { checkWeights: { METAS: -5 } })).toBe(MIN_CHECK_WEIGHT);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('retombe sur le défaut pour une valeur non finie (%s)', (_label, value) => {
    expect(resolveCheckWeight('METAS', { checkWeights: { METAS: value } })).toBe(
      DEFAULT_CHECK_WEIGHT,
    );
  });

  it('retombe sur le défaut pour un critère absent du dictionnaire', () => {
    expect(resolveCheckWeight('AUTRE', { checkWeights: { METAS: 2 } })).toBe(DEFAULT_CHECK_WEIGHT);
  });
});

describe('weightedGlobalScore', () => {
  const entry = (id: string, globalScore: number, status = 'ok') => ({ id, globalScore, status });

  it('équivaut à une moyenne simple quand tous les poids valent 1', () => {
    // Invariant de non-régression : sans pondération configurée, le score doit
    // être exactement celui de la v1 avant introduction des poids.
    const score = weightedGlobalScore([entry('A', 4), entry('B', 2)]);
    expect(score).toBe(3);
  });

  it('pondère selon les coefficients', () => {
    const score = weightedGlobalScore([entry('A', 5), entry('B', 1)], {
      checkWeights: { A: 3, B: 1 },
    });
    // (5×3 + 1×1) / 4 = 4
    expect(score).toBe(4);
  });

  it('EXCLUT les critères non applicables', () => {
    const score = weightedGlobalScore([entry('A', 5), entry('B', 0, 'na')]);
    expect(score).toBe(5);
  });

  it('exclut les critères de poids nul', () => {
    const score = weightedGlobalScore([entry('A', 5), entry('B', 0)], {
      informationalChecks: ['B'],
    });
    expect(score).toBe(5);
  });

  it('rend 5 quand aucun critère ne pèse — un score vide n’est pas un échec', () => {
    expect(weightedGlobalScore([])).toBe(5);
    expect(weightedGlobalScore([entry('A', 0, 'na')])).toBe(5);
    expect(weightedGlobalScore([entry('A', 3)], { informationalChecks: ['A'] })).toBe(5);
  });

  it('arrondit à une décimale', () => {
    const score = weightedGlobalScore([entry('A', 5), entry('B', 4), entry('C', 4)]);
    // 13 / 3 = 4.333… → 4.3
    expect(score).toBe(4.3);
  });
});
