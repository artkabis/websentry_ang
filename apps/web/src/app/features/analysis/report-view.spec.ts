import { describe, expect, it } from 'vitest';
import type { AnalysisReport, CheckResult, CheckStatus } from '@websentry/shared';
import {
  applyFilter,
  countStatuses,
  DEFAULT_FILTER,
  groupChecks,
  hiddenCount,
  locatorUrl,
  MAX_PRIORITY_ACTIONS,
  priorityActions,
  sortItems,
  verdictOf,
} from './report-view';

function check(checkId: string, status: CheckStatus, over: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId,
    checkTitle: `Critère ${checkId}`,
    globalScore: status === 'fail' ? 1 : status === 'warning' ? 3 : 5,
    status,
    items: [],
    summary: 'résumé',
    recommendations: [`Corriger ${checkId}`],
    ...over,
  };
}

function report(checks: CheckResult[], globalScore = 4): AnalysisReport {
  return {
    analyzeId: '11111111-1111-4111-8111-111111111111',
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    htmlSize: 100,
    httpHeaders: {},
    dudaParams: null,
    checks: Object.fromEntries(checks.map(item => [item.checkId, item])),
  };
}

describe('verdictOf', () => {
  it('annonce une page conforme au-dessus de 4', () => {
    expect(verdictOf(4.5, 0)).toMatchObject({ tone: 'good', headline: 'Page conforme' });
  });

  it('distingue « conforme sans réserve » de « conforme avec points à surveiller »', () => {
    expect(verdictOf(4.5, 0).detail).toContain('Aucun point bloquant');
    expect(verdictOf(4.5, 2).detail).toContain('2 point(s) à surveiller');
  });

  it('annonce des corrections à prévoir entre 3 et 4', () => {
    expect(verdictOf(3.5, 3).tone).toBe('warning');
  });

  it('annonce l’urgence sous 3', () => {
    expect(verdictOf(1.5, 8)).toMatchObject({ tone: 'critical', headline: 'Corrections urgentes' });
  });

  it('DIT quoi faire du score, pas seulement ce qu’il vaut', () => {
    // Un verdict qui se contente de qualifier le score n'aide pas : il doit
    // orienter la décision.
    expect(verdictOf(2, 5).detail).toContain('critère(s) en échec');
  });
});

describe('priorityActions', () => {
  it('ne retient que les critères qui demandent une action', () => {
    const actions = priorityActions(report([check('A', 'pass'), check('B', 'fail')]));
    expect(actions.map(action => action.checkId)).toEqual(['B']);
  });

  it('PLACE les échecs avant les avertissements', () => {
    const actions = priorityActions(report([check('A', 'warning'), check('B', 'fail')]));
    expect(actions[0]?.checkId).toBe('B');
  });

  it('DÉPARTAGE par le poids du critère dans le score', () => {
    // Corriger un critère qui pèse double rapporte plus : c'est le calcul que
    // l'utilisateur ne peut pas faire de tête en lisant une liste plate.
    const actions = priorityActions(report([check('LEGER', 'fail'), check('LOURD', 'fail')]), {
      checkWeights: { LOURD: 2, LEGER: 0.5 },
    });
    expect(actions.map(action => action.checkId)).toEqual(['LOURD', 'LEGER']);
  });

  it('ÉCARTE les critères en mode indicatif', () => {
    // Un critère de poids nul n'entre pas dans le score : le proposer en
    // priorité serait un mauvais conseil.
    const actions = priorityActions(report([check('INDICATIF', 'fail')]), {
      informationalChecks: ['INDICATIF'],
    });
    expect(actions).toEqual([]);
  });

  it('écarte un critère sans recommandation exploitable', () => {
    const actions = priorityActions(report([check('A', 'fail', { recommendations: [] })]));
    expect(actions).toEqual([]);
  });

  it('borne la liste — au-delà, ce n’est plus une priorité', () => {
    const many = Array.from({ length: 10 }, (_, i) => check(`C${i}`, 'fail'));
    expect(priorityActions(report(many))).toHaveLength(MAX_PRIORITY_ACTIONS);
  });

  it('produit un ordre STABLE à gravité et poids égaux', () => {
    const checks = [check('ZZZ', 'fail'), check('AAA', 'fail')];
    expect(priorityActions(report(checks)).map(a => a.checkId)).toEqual(['AAA', 'ZZZ']);
  });

  it('remonte le poids, pour que l’interface puisse le justifier', () => {
    const actions = priorityActions(report([check('A', 'fail')]), { checkWeights: { A: 2 } });
    expect(actions[0]?.weight).toBe(2);
  });
});

describe('countStatuses', () => {
  it('compte chaque statut', () => {
    const counts = countStatuses([check('A', 'fail'), check('B', 'pass'), check('C', 'pass')]);
    expect(counts).toEqual({ fail: 1, warning: 0, info: 0, pass: 2, na: 0 });
  });

  it('rend des zéros sur une liste vide', () => {
    expect(countStatuses([])).toEqual({ fail: 0, warning: 0, info: 0, pass: 0, na: 0 });
  });
});

describe('groupChecks', () => {
  it('répartit les critères par famille', () => {
    const groups = groupChecks(report([check('METAS', 'fail'), check('CANONICAL', 'pass')]));
    expect(groups.map(group => group.group)).toEqual(['SEO', 'Technique']);
  });

  it('N’AFFICHE PAS un groupe vide', () => {
    // « Design — 0 critère » sur un rapport partiel n'apprend rien et occupe la
    // place de ce qui compte.
    const groups = groupChecks(report([check('METAS', 'fail')]));
    expect(groups).toHaveLength(1);
  });

  it('range les plus graves en tête de chaque groupe', () => {
    const groups = groupChecks(
      report([check('METAS', 'pass'), check('HN_STRUCTURE', 'fail'), check('BOLD', 'warning')]),
    );
    expect(groups[0]?.checks.map(c => c.checkId)).toEqual(['HN_STRUCTURE', 'BOLD', 'METAS']);
  });

  it('RANGE un critère inconnu du registre plutôt que de le perdre', () => {
    // Le perdre en silence priverait l'utilisateur d'un résultat que le moteur
    // a bel et bien produit.
    const groups = groupChecks(report([check('CRITERE_INEDIT', 'fail')]));
    expect(groups.flatMap(g => g.checks).map(c => c.checkId)).toContain('CRITERE_INEDIT');
  });

  it('signale les groupes qui demandent une action', () => {
    const groups = groupChecks(report([check('METAS', 'pass'), check('CANONICAL', 'fail')]));
    expect(groups.find(g => g.group === 'SEO')?.needsAttention).toBe(false);
    expect(groups.find(g => g.group === 'Technique')?.needsAttention).toBe(true);
  });

  it('ordonne les familles du plus bloquant au plus cosmétique', () => {
    const groups = groupChecks(
      report([check('LOGO', 'fail'), check('METAS', 'fail'), check('CANONICAL', 'fail')]),
    );
    expect(groups.map(g => g.group)).toEqual(['SEO', 'Technique', 'Design']);
  });
});

describe('applyFilter', () => {
  const checks = [check('A', 'fail'), check('B', 'warning'), check('C', 'pass'), check('D', 'na')];

  it('NE MONTRE par défaut que ce qui demande une action', () => {
    // C'est le choix central du remaniement : un rapport qui s'ouvre sur
    // vingt-cinq lignes vertes se survole, et on rate les quatre rouges avec.
    expect(DEFAULT_FILTER).toBe('attention');
    expect(applyFilter(checks, DEFAULT_FILTER).map(c => c.checkId)).toEqual(['A', 'B']);
  });

  it('montre tout à la demande', () => {
    expect(applyFilter(checks, 'all')).toHaveLength(4);
  });

  it('ne modifie pas la liste d’origine', () => {
    const original = [...checks];
    applyFilter(checks, 'attention');
    expect(checks).toEqual(original);
  });
});

describe('hiddenCount', () => {
  it('DIT combien de critères le filtre masque', () => {
    // Ce qui est caché ne doit jamais être implicite.
    const checks = [check('A', 'fail'), check('B', 'pass'), check('C', 'pass')];
    expect(hiddenCount(checks, 'attention')).toBe(2);
    expect(hiddenCount(checks, 'all')).toBe(0);
  });
});

describe('sortItems', () => {
  it('remonte les points de contrôle les plus graves', () => {
    // Un critère peut porter quarante items dont deux fautifs : les remonter
    // évite de faire dérouler l'utilisateur jusqu'à ce qu'il abandonne.
    const items = [
      { status: 'pass' as const, label: 'a' },
      { status: 'fail' as const, label: 'b' },
      { status: 'warning' as const, label: 'c' },
    ];
    expect(sortItems(items).map(item => item.label)).toEqual(['b', 'c', 'a']);
  });

  it('ne modifie pas la liste d’origine', () => {
    const items = [{ status: 'pass' as const }, { status: 'fail' as const }];
    const copy = [...items];
    sortItems(items);
    expect(items).toEqual(copy);
  });
});

describe('locatorUrl', () => {
  const page = 'https://exemple.fr/';

  it('construit un fragment de texte', () => {
    expect(locatorUrl(page, { text: 'Cliquez ici' })).toBe(
      'https://exemple.fr/#:~:text=Cliquez%20ici',
    );
  });

  it('cible une plage début…fin', () => {
    expect(locatorUrl(page, { text: 'début', textEnd: 'fin' })).toBe(
      'https://exemple.fr/#:~:text=d%C3%A9but,fin',
    );
  });

  it('encadre par le contexte quand il est fourni', () => {
    // Les `-` de `avant-,` et `,-après` sont les séparateurs SYNTAXIQUES de la
    // norme : ils restent littéraux. Seul le contenu est encodé.
    const url = locatorUrl(page, { text: 'ici', prefix: 'avant', suffix: 'après' });
    expect(url).toBe('https://exemple.fr/#:~:text=avant-,ici,-apr%C3%A8s');
  });

  it('ÉCHAPPE le tiret, qui a une signification syntaxique', () => {
    // Laisser passer un `-` brut produirait un lien silencieusement faux : le
    // navigateur le lirait comme un séparateur de contexte.
    expect(locatorUrl(page, { text: 'mi-temps' })).toContain('mi%2Dtemps');
  });

  it('échappe la virgule, séparateur de plage', () => {
    expect(locatorUrl(page, { text: 'a, b' })).toContain('a%2C%20b');
  });

  it('rend null sans texte à cibler', () => {
    expect(locatorUrl(page, {})).toBeNull();
    expect(locatorUrl(page, { text: '   ' })).toBeNull();
  });
});
