import { describe, expect, it } from 'vitest';
import {
  classeEtat,
  formatDuree,
  formatNombre,
  formatUptime,
  libelleEtat,
  resumeGlobal,
} from './supervision-format';

describe('libellés d’état', () => {
  it.each([
    ['ok', 'Opérationnel'],
    ['degrade', 'Dégradé'],
    ['panne', 'En panne'],
  ] as const)('nomme %s', (etat, libelle) => {
    // Le libellé porte le sens : la couleur seule est invisible au lecteur
    // d'écran et ambiguë en cas de daltonisme.
    expect(libelleEtat(etat)).toBe(libelle);
  });

  it('DISTINGUE les trois résumés', () => {
    const resumes = (['ok', 'degrade', 'panne'] as const).map(resumeGlobal);
    expect(new Set(resumes).size).toBe(3);
    expect(resumeGlobal('degrade')).toMatch(/repli/);
    expect(resumeGlobal('panne')).toMatch(/hors service/);
  });

  it('donne une classe DIFFÉRENTE à chaque état', () => {
    // Deux états qui se ressemblent à l'écran ne se distinguent plus.
    const classes = (['ok', 'degrade', 'panne'] as const).map(classeEtat);
    expect(new Set(classes).size).toBe(3);
  });

  it('n’emploie PAS la couleur d’alerte pour un état sain', () => {
    expect(classeEtat('ok')).not.toContain('danger');
    expect(classeEtat('panne')).toContain('danger');
    expect(classeEtat('degrade')).toContain('warn');
  });
});

describe('durée depuis le démarrage', () => {
  it('affiche les secondes SOUS la minute', () => {
    expect(formatUptime(0)).toBe('0 s');
    expect(formatUptime(59)).toBe('59 s');
  });

  it('bascule en minutes à partir d’une minute', () => {
    expect(formatUptime(60)).toBe('1 min');
    expect(formatUptime(3599)).toBe('59 min');
  });

  it('compose heures et minutes', () => {
    expect(formatUptime(3600)).toBe('1 h');
    expect(formatUptime(3600 + 120)).toBe('1 h 2 min');
  });

  it('ABANDONNE les minutes au-delà d’un jour', () => {
    // « 3 j 4 h 12 min » donne une précision que personne n'utilise et qui
    // change à chaque relevé.
    expect(formatUptime(86_400)).toBe('1 j');
    expect(formatUptime(86_400 + 3600 + 120)).toBe('1 j 1 h');
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 720)).toBe('3 j 4 h');
  });

  it('n’affiche pas une heure nulle', () => {
    expect(formatUptime(86_400 + 120)).toBe('1 j');
  });
});

describe('nombres', () => {
  it('sépare les milliers — un « 12345 » brut se lit mal', () => {
    // L'espace insécable étroit du français : on compare sur le chiffre, pas
    // sur l'octet de séparation, qui dépend de l'environnement.
    expect(formatNombre(12_345).replace(/\s/g, ' ')).toBe('12 345');
  });

  it('laisse les petits nombres intacts', () => {
    expect(formatNombre(0)).toBe('0');
    expect(formatNombre(42)).toBe('42');
  });
});

describe('durée d’un passage', () => {
  it('reste en millisecondes sous la seconde', () => {
    expect(formatDuree(0)).toBe('0 ms');
    expect(formatDuree(999)).toBe('999 ms');
  });

  it('passe en secondes avec une décimale', () => {
    expect(formatDuree(1_000)).toBe('1.0 s');
    expect(formatDuree(8_200)).toBe('8.2 s');
  });

  it('compose minutes et secondes au-delà d’une minute', () => {
    expect(formatDuree(60_000)).toBe('1 min 0 s');
    expect(formatDuree(125_000)).toBe('2 min 5 s');
  });
});

describe('exhaustivité', () => {
  it('couvre les TROIS états, sans repli à l’exécution', () => {
    // La garantie est dans le TYPE : un quatrième état ferait échouer la
    // compilation, ce qui vaut mieux qu'un libellé brut découvert à l'écran.
    // Ce test vérifie qu'aucun état connu ne tombe dans un trou.
    for (const etat of ['ok', 'degrade', 'panne'] as const) {
      expect(libelleEtat(etat)).not.toBe(etat);
      expect(resumeGlobal(etat)).not.toBe('');
      expect(classeEtat(etat)).toContain('rounded-full');
    }
  });
});
