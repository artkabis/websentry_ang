import { describe, expect, it } from 'vitest';
import type { UsageDay, UsageFunnelStep } from '@websentry/shared';
import {
  anonymisationEnRetard,
  barresDeLaSerie,
  compteurMontrable,
  expliquerEtape,
  jourCourt,
  libelleEtape,
  libellePeriode,
  libelleRetention,
  paramsDepuisPeriode,
  partDuTunnel,
  periodeDepuisParams,
  PERIODES,
  resumerSerie,
} from './usage-format';

const TUNNEL: UsageFunnelStep[] = [
  { cle: 'connexion', comptes: 10, actions: 50 },
  { cle: 'analyse', comptes: 6, actions: 120 },
  { cle: 'exploitation', comptes: 3, actions: 9 },
];

function jour(jour: string, connexions: number, analyses: number): UsageDay {
  return { jour, connexions, analyses };
}

describe('période', () => {
  it('retient 30 jours sans paramètre, ou sur un paramètre fautif', () => {
    expect(periodeDepuisParams({})).toBe('30j');
    expect(periodeDepuisParams({ periode: '1j' })).toBe('30j');
    expect(periodeDepuisParams({ periode: '' })).toBe('30j');
    expect(periodeDepuisParams({ periode: null })).toBe('30j');
  });

  it('lit les trois fenêtres du catalogue', () => {
    for (const periode of PERIODES) {
      expect(periodeDepuisParams({ periode })).toBe(periode);
    }
  });

  it('coupe les espaces autour', () => {
    expect(periodeDepuisParams({ periode: '  7j ' })).toBe('7j');
  });

  it('n’écrit PAS la valeur par défaut dans l’URL', () => {
    // Une URL propre se partage ; une URL pleine de valeurs par défaut ment
    // sur ce qui a été choisi.
    expect(paramsDepuisPeriode('30j')).toEqual({});
    expect(paramsDepuisPeriode('7j')).toEqual({ periode: '7j' });
  });

  it('fait un ALLER-RETOUR sans perte', () => {
    for (const periode of PERIODES) {
      expect(periodeDepuisParams(paramsDepuisPeriode(periode))).toBe(periode);
    }
  });

  it('nomme la fenêtre en jours', () => {
    expect(libellePeriode('7j')).toBe('7 derniers jours');
    expect(libellePeriode('90j')).toBe('90 derniers jours');
  });
});

describe('tunnel', () => {
  it('nomme et EXPLIQUE chaque étape', () => {
    for (const etape of TUNNEL) {
      expect(libelleEtape(etape.cle).length).toBeGreaterThan(0);
      // Ce que l'étape prouve est dit à l'écran, pas laissé à deviner.
      expect(expliquerEtape(etape.cle).length).toBeGreaterThan(0);
    }
    expect(libelleEtape('exploitation')).toContain('Agissent');
  });

  it('rapporte chaque étape à l’ENTRÉE, pas à la précédente', () => {
    // Rapportée à la précédente, la part dirait « 60 % » puis « 50 % » sur un
    // tunnel qui perd les sept dixièmes de son monde.
    expect(partDuTunnel(TUNNEL[0]!, TUNNEL)).toBe(100);
    expect(partDuTunnel(TUNNEL[1]!, TUNNEL)).toBe(60);
    expect(partDuTunnel(TUNNEL[2]!, TUNNEL)).toBe(30);
  });

  it('rend 0 % plutôt qu’une division par zéro', () => {
    const vide: UsageFunnelStep[] = [
      { cle: 'connexion', comptes: 0, actions: 0 },
      { cle: 'analyse', comptes: 0, actions: 0 },
    ];
    expect(partDuTunnel(vide[1]!, vide)).toBe(0);
    expect(partDuTunnel(vide[0]!, [])).toBe(0);
  });
});

describe('seuil d’anonymat', () => {
  it('remplace un compteur trop petit, sans le masquer', () => {
    // Masquer entièrement laisserait croire à une absence ; « 1 » désignerait
    // quelqu'un dans une équipe de dix.
    expect(compteurMontrable(1)).toBe('moins de 5');
    expect(compteurMontrable(4)).toBe('moins de 5');
    expect(compteurMontrable(5)).toBe('5');
    expect(compteurMontrable(42)).toBe('42');
  });

  it('laisse ZÉRO tel quel', () => {
    expect(compteurMontrable(0)).toBe('0');
  });
});

describe('géométrie du graphe', () => {
  it('met les deux séries à la MÊME échelle', () => {
    // Deux échelles indépendantes feraient paraître trois connexions aussi
    // hautes que trois cents analyses.
    const barres = barresDeLaSerie([jour('2026-03-01', 3, 300), jour('2026-03-02', 3, 0)]);

    expect(barres[0]?.hauteurAnalyses).toBe(100);
    expect(barres[0]?.hauteurConnexions).toBe(1);
    expect(barres[1]?.hauteurConnexions).toBe(1);
  });

  it('rend une série PLATE plutôt qu’une division par zéro', () => {
    const barres = barresDeLaSerie([jour('2026-03-01', 0, 0), jour('2026-03-02', 0, 0)]);

    expect(barres.every(b => b.hauteurConnexions === 0 && b.hauteurAnalyses === 0)).toBe(true);
  });

  it('conserve les nombres bruts à côté des hauteurs', () => {
    // Le tableau qui double le graphe lit les mêmes valeurs.
    const barres = barresDeLaSerie([jour('2026-03-01', 3, 12)]);

    expect(barres[0]).toMatchObject({ connexions: 3, analyses: 12 });
  });

  it('rend une liste vide sur une série vide', () => {
    expect(barresDeLaSerie([])).toEqual([]);
  });

  it('abrège le jour pour l’axe', () => {
    expect(jourCourt('2026-03-24')).toBe('24/03');
    // Une valeur inattendue ne fait pas tomber l'écran.
    expect(jourCourt('bizarre')).toBe('??/??');
  });
});

describe('résumé de la courbe', () => {
  it('DIT ce que le graphe montre', () => {
    // Un graphe est une image : sans cette phrase, il ne dit rien à qui ne le
    // voit pas.
    const resume = resumerSerie([
      jour('2026-03-01', 2, 5),
      jour('2026-03-02', 4, 30),
      jour('2026-03-03', 1, 0),
    ]);

    expect(resume).toContain('7 connexion(s)');
    expect(resume).toContain('35 analyse(s)');
    expect(resume).toContain('02/03');
  });

  it('annonce une période vide plutôt qu’une phrase vide', () => {
    expect(resumerSerie([])).toBe('Aucune activité sur la période.');
  });

  it('tient sur une série entièrement à zéro', () => {
    const resume = resumerSerie([jour('2026-03-01', 0, 0)]);
    expect(resume).toContain('0 connexion(s)');
  });
});

describe('gouvernance', () => {
  it('distingue l’ABSENCE de purge d’une purge à zéro jour', () => {
    // Le taire laisserait croire à une purge qui n'existe pas.
    expect(libelleRetention(null)).toBe('Aucune purge automatique');
    expect(libelleRetention(180)).toBe('180 jours');
  });

  it('signale un retard d’anonymisation', () => {
    expect(anonymisationEnRetard(0)).toBe(false);
    expect(anonymisationEnRetard(37)).toBe(true);
  });
});
