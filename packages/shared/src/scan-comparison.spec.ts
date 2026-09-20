import { describe, expect, it } from 'vitest';
import {
  CHECK_HEALTH_ORDER,
  compareCheckSummaries,
  comparePages,
  compareStatus,
  type ComparablePage,
} from './scan-comparison.js';
import type { CheckStatus, CheckSummary } from './schemas/scan.schema.js';

const page = (
  url: string,
  globalScore: number | null,
  checkSummary: CheckSummary = {},
): ComparablePage => ({ url, globalScore, checkSummary });

describe('compareStatus', () => {
  it.each<[CheckStatus, CheckStatus]>([
    ['pass', 'warning'],
    ['pass', 'fail'],
    ['warning', 'fail'],
    ['info', 'warning'],
    ['pass', 'info'],
  ])('voit une dégradation de %s vers %s', (base, target) => {
    expect(compareStatus(base, target)).toBe('degraded');
  });

  it.each<[CheckStatus, CheckStatus]>([
    ['fail', 'warning'],
    ['warning', 'pass'],
    ['fail', 'pass'],
    ['info', 'pass'],
  ])('voit une amélioration de %s vers %s', (base, target) => {
    expect(compareStatus(base, target)).toBe('improved');
  });

  it.each<CheckStatus>(['pass', 'info', 'warning', 'fail'])('voit %s stable', status => {
    expect(compareStatus(status, status)).toBe('stable');
  });

  it.each<[CheckStatus, CheckStatus]>([
    ['na', 'fail'],
    ['pass', 'na'],
    ['na', 'na'],
  ])('IGNORE toute transition impliquant na (%s → %s)', (base, target) => {
    // Traiter « non applicable » comme un échec ferait apparaître un
    // effondrement de qualité le jour où un critère devient inapplicable —
    // un changement de périmètre déguisé en régression.
    expect(compareStatus(base, target)).toBe('ignored');
  });

  it('place na hors de l’échelle de santé', () => {
    expect(CHECK_HEALTH_ORDER.na).toBeLessThan(CHECK_HEALTH_ORDER.fail);
  });
});

describe('compareCheckSummaries', () => {
  it('ne retient que les critères qui ont bougé', () => {
    const diffs = compareCheckSummaries(
      { METAS: 'pass', HN_STRUCTURE: 'pass', IMAGES: 'warning' },
      { METAS: 'fail', HN_STRUCTURE: 'pass', IMAGES: 'pass' },
    );
    expect(diffs.map(d => d.checkId)).toEqual(['METAS', 'IMAGES']);
  });

  it('remonte les améliorations, contrairement à la v1', () => {
    // La v1 masquait les gains pour éviter le bruit pendant une analyse. Dans un
    // écran dont le sujet EST l'évolution, cela revenait à laisser croire qu'un
    // site ne progresse jamais.
    const diffs = compareCheckSummaries({ METAS: 'fail' }, { METAS: 'pass' });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.trend).toBe('improved');
  });

  it('classe les dégradations avant les améliorations', () => {
    const diffs = compareCheckSummaries(
      { AAA_GAIN: 'fail', ZZZ_PERTE: 'pass' },
      { AAA_GAIN: 'pass', ZZZ_PERTE: 'fail' },
    );
    expect(diffs.map(d => d.trend)).toEqual(['degraded', 'improved']);
  });

  it('produit un ordre stable à tendance égale', () => {
    const diffs = compareCheckSummaries({ ZZZ: 'pass', AAA: 'pass' }, { ZZZ: 'fail', AAA: 'fail' });
    expect(diffs.map(d => d.checkId)).toEqual(['AAA', 'ZZZ']);
  });

  it('écarte un critère absent du scan récent', () => {
    expect(compareCheckSummaries({ RETIRE: 'pass' }, {})).toEqual([]);
  });

  it('écarte un critère apparu entre les deux scans', () => {
    // Un critère ajouté au référentiel n'est ni un gain ni une perte : il n'a
    // pas de point de comparaison.
    expect(compareCheckSummaries({}, { NOUVEAU: 'fail' })).toEqual([]);
  });

  it('ne lit pas les clés héritées du prototype', () => {
    const base = Object.create({ HERITE: 'pass' }) as CheckSummary;
    base.METAS = 'pass';
    expect(compareCheckSummaries(base, { METAS: 'pass', HERITE: 'fail' })).toEqual([]);
  });
});

describe('comparePages', () => {
  it('apparie les pages par URL et calcule l’écart de score', () => {
    const { pages } = comparePages(
      [page('https://a.fr/', 4, { METAS: 'pass' })],
      [page('https://a.fr/', 3, { METAS: 'fail' })],
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ change: 'changed', scoreDelta: -1, degraded: 1, improved: 0 });
  });

  it('oriente le delta dans le sens de la lecture : négatif = ça a baissé', () => {
    const { pages } = comparePages([page('https://a.fr/', 2)], [page('https://a.fr/', 4.5)]);
    expect(pages[0]?.scoreDelta).toBe(2.5);
  });

  it('arrondit le delta au dixième', () => {
    const { pages } = comparePages([page('https://a.fr/', 4.05)], [page('https://a.fr/', 4.17)]);
    expect(pages[0]?.scoreDelta).toBe(0.1);
  });

  it('SIGNALE une page disparue au lieu de l’écarter', () => {
    // Un site qui perd la moitié de ses pages entre deux audits est un fait à
    // montrer, pas un détail d'appariement.
    const { pages, summary } = comparePages([page('https://a.fr/partie', 4)], []);
    expect(summary.removed).toBe(1);
    expect(pages[0]).toMatchObject({ change: 'removed', targetScore: null, scoreDelta: null });
  });

  it('signale une page apparue', () => {
    const { pages, summary } = comparePages([], [page('https://a.fr/neuve', 4)]);
    expect(summary.added).toBe(1);
    expect(pages[0]).toMatchObject({ change: 'added', baseScore: null, scoreDelta: null });
  });

  it('compte une page inchangée quand ni score ni critère ne bougent', () => {
    const { summary, pages } = comparePages(
      [page('https://a.fr/', 4, { METAS: 'pass' })],
      [page('https://a.fr/', 4, { METAS: 'pass' })],
    );
    expect(summary.unchanged).toBe(1);
    expect(pages[0]?.change).toBe('unchanged');
  });

  it('voit un changement de score SEUL, sans mouvement de statut', () => {
    // Une pondération modifiée fait bouger le score sans qu'aucun statut ne
    // change : ignorer ce cas ferait passer la page pour identique.
    const { summary, pages } = comparePages(
      [page('https://a.fr/', 4, { METAS: 'pass' })],
      [page('https://a.fr/', 3.5, { METAS: 'pass' })],
    );
    expect(pages[0]?.change).toBe('changed');
    expect(summary.degraded).toBe(1);
  });

  it('classe une page en dégradée dès qu’un critère recule, même à score stable', () => {
    const { summary } = comparePages(
      [page('https://a.fr/', 4, { METAS: 'pass', IMAGES: 'fail' })],
      [page('https://a.fr/', 4, { METAS: 'fail', IMAGES: 'pass' })],
    );
    expect(summary.degraded).toBe(1);
    expect(summary.improved).toBe(0);
  });

  it('classe une page en améliorée quand rien ne recule', () => {
    const { summary } = comparePages(
      [page('https://a.fr/', 3, { METAS: 'fail' })],
      [page('https://a.fr/', 4, { METAS: 'pass' })],
    );
    expect(summary.improved).toBe(1);
  });

  it('ne calcule pas de delta quand un score manque', () => {
    const { pages } = comparePages([page('https://a.fr/', null)], [page('https://a.fr/', 4)]);
    expect(pages[0]?.scoreDelta).toBeNull();
    expect(pages[0]?.change).toBe('unchanged');
  });

  it('remonte les pages retirées puis ajoutées avant les pages comparées', () => {
    const { pages } = comparePages(
      [page('https://a.fr/perdue', 4), page('https://a.fr/commune', 4)],
      [page('https://a.fr/neuve', 4), page('https://a.fr/commune', 1)],
    );
    expect(pages.map(p => p.change)).toEqual(['removed', 'added', 'changed']);
  });

  it('ordonne alphabétiquement plusieurs pages disparues, faute de delta pour les départager', () => {
    // Retirées comme ajoutées n'ont qu'un seul score : rien à comparer. L'URL
    // est alors le seul critère qui rende la liste reproductible d'un appel
    // à l'autre.
    const { pages } = comparePages(
      [page('https://a.fr/z', 4), page('https://a.fr/a', 2)],
      [page('https://a.fr/neuve-z', 4), page('https://a.fr/neuve-a', 1)],
    );
    expect(pages.map(p => p.url)).toEqual([
      'https://a.fr/a',
      'https://a.fr/z',
      'https://a.fr/neuve-a',
      'https://a.fr/neuve-z',
    ]);
  });

  it('trie les pages comparées de la plus dégradée à la plus améliorée', () => {
    const { pages } = comparePages(
      [page('https://a.fr/1', 4), page('https://a.fr/2', 4), page('https://a.fr/3', 4)],
      [page('https://a.fr/1', 4.5), page('https://a.fr/2', 1), page('https://a.fr/3', 3)],
    );
    expect(pages.map(p => p.url)).toEqual(['https://a.fr/2', 'https://a.fr/3', 'https://a.fr/1']);
  });

  it('départage par nombre de critères dégradés à delta égal', () => {
    const { pages } = comparePages(
      [
        page('https://a.fr/1', 4, { A_UN: 'pass' }),
        page('https://a.fr/2', 4, { A_UN: 'pass', B_DEUX: 'pass' }),
      ],
      [
        page('https://a.fr/1', 4, { A_UN: 'fail' }),
        page('https://a.fr/2', 4, { A_UN: 'fail', B_DEUX: 'fail' }),
      ],
    );
    expect(pages.map(p => p.url)).toEqual(['https://a.fr/2', 'https://a.fr/1']);
  });

  it('produit un ordre stable indépendant de l’ordre des lignes en base', () => {
    const a = [page('https://a.fr/z', 4), page('https://a.fr/a', 4)];
    const b = [page('https://a.fr/a', 4), page('https://a.fr/z', 4)];
    const direct = comparePages(a, a).pages.map(p => p.url);
    const inverse = comparePages(b, b).pages.map(p => p.url);
    expect(direct).toEqual(inverse);
  });

  it('agrège un lot mêlant tous les cas', () => {
    const { summary } = comparePages(
      [
        page('https://a.fr/stable', 4, { METAS: 'pass' }),
        page('https://a.fr/pire', 4, { METAS: 'pass' }),
        page('https://a.fr/mieux', 2, { METAS: 'fail' }),
        page('https://a.fr/partie', 3),
      ],
      [
        page('https://a.fr/stable', 4, { METAS: 'pass' }),
        page('https://a.fr/pire', 2, { METAS: 'fail' }),
        page('https://a.fr/mieux', 4, { METAS: 'pass' }),
        page('https://a.fr/neuve', 5),
      ],
    );
    expect(summary).toEqual({ added: 1, removed: 1, degraded: 1, improved: 1, unchanged: 1 });
  });

  it('gère deux sessions vides sans rien inventer', () => {
    const { pages, summary } = comparePages([], []);
    expect(pages).toEqual([]);
    expect(summary).toEqual({ added: 0, removed: 0, degraded: 0, improved: 0, unchanged: 0 });
  });
});
