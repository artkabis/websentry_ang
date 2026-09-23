import { describe, expect, it } from 'vitest';
import {
  JOURS_PAR_PERIODE,
  SEUIL_ANONYMAT,
  sousLeSeuil,
  UsageDaySchema,
  UsageFunnelStepSchema,
  UsageGammeSchema,
  UsageGovernanceSchema,
  UsageOverviewSchema,
  UsagePeriodSchema,
  UsageQuerySchema,
} from './usage.schema.js';

const APERCU = {
  periode: '30j',
  depuis: '2026-01-01T00:00:00.000Z',
  jusqua: '2026-01-31T00:00:00.000Z',
  comptesActifs: 7,
  tunnel: [
    { cle: 'connexion', comptes: 7, actions: 42 },
    { cle: 'analyse', comptes: 5, actions: 130 },
    { cle: 'exploitation', comptes: 3, actions: 9 },
  ],
  parJour: [{ jour: '2026-01-01', connexions: 3, analyses: 12 }],
  gammes: [{ gamme: 'premium', analyses: 80, scoreMoyen: 72.5 }],
};

describe('fenêtre d’observation', () => {
  it('n’admet que trois fenêtres FERMÉES', () => {
    // Une plage libre laisserait isoler une heure, et un compteur sur une
    // heure dans une équipe de dix désigne quelqu'un.
    expect(UsagePeriodSchema.options).toEqual(['7j', '30j', '90j']);
    expect(UsagePeriodSchema.safeParse('1j').success).toBe(false);
    expect(UsagePeriodSchema.safeParse('2026-01-01..2026-01-02').success).toBe(false);
  });

  it('donne un nombre de jours à chaque fenêtre', () => {
    for (const periode of UsagePeriodSchema.options) {
      expect(JOURS_PAR_PERIODE[periode]).toBeGreaterThan(0);
    }
    expect(JOURS_PAR_PERIODE['30j']).toBe(30);
  });

  it('retient 30 jours par défaut', () => {
    expect(UsageQuerySchema.parse({})).toEqual({ periode: '30j' });
  });

  it('REFUSE un paramètre inconnu', () => {
    expect(UsageQuerySchema.safeParse({ periode: '7j', acteur: 'alice' }).success).toBe(false);
  });
});

describe('seuil d’anonymat', () => {
  it('signale un compteur trop petit pour protéger qui que ce soit', () => {
    expect(SEUIL_ANONYMAT).toBe(5);
    expect(sousLeSeuil(1)).toBe(true);
    expect(sousLeSeuil(4)).toBe(true);
    expect(sousLeSeuil(5)).toBe(false);
    expect(sousLeSeuil(50)).toBe(false);
  });

  it('ne signale PAS un compteur à zéro', () => {
    // Zéro ne désigne personne : le masquer ferait croire à une présence.
    expect(sousLeSeuil(0)).toBe(false);
  });
});

describe('UsageOverviewSchema', () => {
  it('accepte un aperçu conforme', () => {
    expect(UsageOverviewSchema.parse(APERCU)).toEqual(APERCU);
  });

  it('n’admet AUCUN champ hors du contrat', () => {
    // C'est le garde-fou du module : une API qui se mettrait à rendre des noms
    // serait rejetée à la frontière, côté client comme côté serveur.
    expect(UsageOverviewSchema.safeParse({ ...APERCU, acteurs: ['alice'] }).success).toBe(false);
    expect(
      UsageFunnelStepSchema.safeParse({ cle: 'analyse', comptes: 1, actions: 1, qui: 'alice' })
        .success,
    ).toBe(false);
  });

  it('REFUSE une étape de tunnel inventée', () => {
    expect(UsageFunnelStepSchema.safeParse({ cle: 'export', comptes: 1, actions: 1 }).success).toBe(
      false,
    );
  });

  it('REFUSE un compteur négatif', () => {
    expect(
      UsageFunnelStepSchema.safeParse({ cle: 'analyse', comptes: -1, actions: 0 }).success,
    ).toBe(false);
  });

  it('EXIGE un jour bien formé', () => {
    expect(UsageDaySchema.safeParse({ jour: '2026-1-1', connexions: 0, analyses: 0 }).success).toBe(
      false,
    );
    expect(
      UsageDaySchema.safeParse({ jour: '2026-01-01T00:00:00Z', connexions: 0, analyses: 0 })
        .success,
    ).toBe(false);
  });

  it('distingue un score ABSENT d’un score nul', () => {
    // Aucune page notée n'est pas la même chose qu'un score de zéro.
    expect(
      UsageGammeSchema.parse({ gamme: 'premium', analyses: 3, scoreMoyen: null }).scoreMoyen,
    ).toBeNull();
    expect(
      UsageGammeSchema.parse({ gamme: 'premium', analyses: 3, scoreMoyen: 0 }).scoreMoyen,
    ).toBe(0);
  });
});

describe('UsageGovernanceSchema', () => {
  const GOUVERNANCE = {
    sources: [
      {
        table: 'audit_log',
        finalite: 'Traçabilité des actions sensibles',
        donnees: ['identifiant de compte', 'nom au moment de l’action', 'adresse IP'],
        retentionJours: 180,
      },
    ],
    anonymisation: {
      apresJours: 180,
      anonymisees: 120,
      enAttente: 4,
      dernierPassage: '2026-01-31T03:00:00.000Z',
    },
    collecteDediee: false as const,
  };

  it('accepte un registre conforme', () => {
    expect(UsageGovernanceSchema.parse(GOUVERNANCE)).toEqual(GOUVERNANCE);
  });

  it('n’admet PAS qu’on annonce une collecte dédiée', () => {
    // Le type le rend impossible : la réponse est affichée, pas affirmée dans
    // une documentation que personne ne relit.
    expect(UsageGovernanceSchema.safeParse({ ...GOUVERNANCE, collecteDediee: true }).success).toBe(
      false,
    );
  });

  it('accepte une source SANS purge, en le disant', () => {
    const sansPurge = {
      ...GOUVERNANCE,
      sources: [{ ...GOUVERNANCE.sources[0]!, retentionJours: null }],
    };
    expect(UsageGovernanceSchema.parse(sansPurge).sources[0]?.retentionJours).toBeNull();
  });

  it('accepte l’absence de dernier passage', () => {
    const neuf = {
      ...GOUVERNANCE,
      anonymisation: { ...GOUVERNANCE.anonymisation, dernierPassage: null },
    };
    expect(UsageGovernanceSchema.parse(neuf).anonymisation.dernierPassage).toBeNull();
  });
});
