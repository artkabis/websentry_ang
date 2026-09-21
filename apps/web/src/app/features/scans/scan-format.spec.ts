import { describe, expect, it } from 'vitest';
import {
  changeBadgeClass,
  changeLabel,
  checkStatusLabel,
  formatDelta,
  formatScore,
  reportAvailable,
  reportStateLabel,
  scoreBadgeClass,
  scoreClassOf,
  scoreLabelOf,
  siteRowSummary,
  trendBadgeClass,
} from './scan-format';

describe('scoreClassOf', () => {
  it.each([
    [5, 'good'],
    [4, 'good'],
    [3.9, 'warning'],
    [3, 'warning'],
    [2.9, 'critical'],
    [0, 'critical'],
  ])('classe %s en %s', (score, expected) => {
    expect(scoreClassOf(score)).toBe(expected);
  });

  it('distingue l’absence de note d’une mauvaise note', () => {
    // Une page non évaluée n'est pas une page en échec : les confondre ferait
    // apparaître un site sain comme critique.
    expect(scoreClassOf(null)).toBe('unknown');
  });
});

describe('scoreLabelOf', () => {
  it('donne un libellé TEXTUEL à chaque classe', () => {
    // La couleur seule est invisible pour un lecteur d'écran et ambiguë en cas
    // de daltonisme (WCAG 1.4.1).
    expect(scoreLabelOf(4.5)).toBe('bon');
    expect(scoreLabelOf(3.5)).toBe('à surveiller');
    expect(scoreLabelOf(1)).toBe('critique');
    expect(scoreLabelOf(null)).toBe('non évalué');
  });
});

describe('formatScore', () => {
  it('formate à la française, au dixième', () => {
    expect(formatScore(4.25)).toBe('4,3');
    expect(formatScore(3)).toBe('3,0');
  });

  it('marque l’absence par un tiret', () => {
    expect(formatScore(null)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('PORTE toujours le signe — il est le sens même de la valeur', () => {
    expect(formatDelta(1.2)).toBe('+1,2');
    expect(formatDelta(-1.2)).toBe('−1,2');
  });

  it('distingue « stable » de « inconnu »', () => {
    expect(formatDelta(0)).toBe('=');
    expect(formatDelta(null)).toBe('—');
  });
});

describe('reportStateLabel', () => {
  it('DISTINGUE archivé et purgé', () => {
    // Le premier se consulte normalement, le second a disparu. Les confondre
    // envoie chercher une donnée qui n'existe plus — le défaut de la v1.
    expect(reportStateLabel('inline')).toBe('Rapport disponible');
    expect(reportStateLabel('compressed')).toBe('Rapport archivé');
    expect(reportStateLabel('purged')).toBe('Rapport purgé');
  });
});

describe('reportAvailable', () => {
  it('n’ouvre le rapport que lorsqu’il existe encore', () => {
    expect(reportAvailable('inline')).toBe(true);
    expect(reportAvailable('compressed')).toBe(true);
    expect(reportAvailable('purged')).toBe(false);
  });
});

describe('checkStatusLabel', () => {
  it.each([
    ['pass', 'conforme'],
    ['info', 'informatif'],
    ['warning', 'à surveiller'],
    ['fail', 'en échec'],
    ['na', 'non applicable'],
  ] as const)('traduit %s', (status, expected) => {
    expect(checkStatusLabel(status)).toBe(expected);
  });
});

describe('siteRowSummary', () => {
  it('résume une ligne en une phrase lisible à voix haute', () => {
    const summary = siteRowSummary({
      domain: 'exemple.fr',
      gamme: 'premium',
      pageCount: 12,
      avgScore: 4.2,
    });
    expect(summary).toBe('exemple.fr, gamme premium — 12 page(s), score moyen 4,2 sur 5, bon');
  });

  it('nomme explicitement l’absence de gamme', () => {
    const summary = siteRowSummary({
      domain: 'exemple.fr',
      gamme: null,
      pageCount: 1,
      avgScore: null,
    });
    expect(summary).toContain('sans gamme');
    expect(summary).toContain('score non évalué');
  });
});

describe('scoreBadgeClass', () => {
  it.each([
    [4.5, 'ok'],
    [3.5, 'warn'],
    [1, 'danger'],
    [null, 'sunken'],
  ])('colore %s en %s', (score, hue) => {
    expect(scoreBadgeClass(score)).toContain(hue);
  });

  it('accepte des classes propres à l’emplacement', () => {
    expect(scoreBadgeClass(4, 'shrink-0')).toContain('shrink-0');
  });

  it('n’ajoute rien quand rien n’est demandé', () => {
    expect(scoreBadgeClass(4)).not.toContain('  ');
  });
});

describe('changeLabel', () => {
  it.each([
    ['added', 'Apparue'],
    ['removed', 'Disparue'],
    ['changed', 'Modifiée'],
    ['unchanged', 'Inchangée'],
  ] as const)('nomme %s', (change, expected) => {
    expect(changeLabel(change)).toBe(expected);
  });
});

describe('changeBadgeClass', () => {
  it('DISTINGUE visuellement les quatre natures de changement', () => {
    // Une page disparue et une page modifiée n'appellent pas la même réaction :
    // les afficher à l'identique noierait l'information.
    const classes = (['added', 'removed', 'changed', 'unchanged'] as const).map(changeBadgeClass);
    expect(new Set(classes).size).toBe(4);
  });
});

describe('trendBadgeClass', () => {
  it('SIGNALE la dégradation en rouge, le reste en vert', () => {
    expect(trendBadgeClass('degraded')).toContain('danger');
    expect(trendBadgeClass('improved')).toContain('ok');
    expect(trendBadgeClass('stable')).toContain('ok');
    expect(trendBadgeClass('ignored')).toContain('ok');
  });
});
