import { describe, expect, it } from 'vitest';
import {
  AnalysisSettingsSchema,
  DEFAULT_EXCLUDED_DOMAINS,
  DEFAULT_EXCLUDED_WORDS,
  defaultAnalysisSettings,
  PageRuleSchema,
} from './settings.schema.js';

/** Réglages valides minimaux — Zod complète le reste par ses défauts. */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...over };
}

describe('AnalysisSettingsSchema', () => {
  describe('valeurs par défaut', () => {
    it('produit un jeu complet à partir d’un objet vide', () => {
      const settings = defaultAnalysisSettings();
      expect(settings.meta.title).toEqual({ min: 50, max: 65 });
      expect(settings.meta.description).toEqual({ min: 140, max: 156 });
      expect(settings.hn).toMatchObject({ minLength: 50, maxLength: 90 });
      expect(settings.bold).toEqual({ min: 3, max: 5, minParentWords: 20 });
      expect(settings.content).toEqual({ minWords: 300, warningWords: 500 });
    });

    it('reprend les listes par défaut de la v1 — ce sont des valeurs de contrat', () => {
      const settings = defaultAnalysisSettings();
      expect(settings.hn.excludedWords).toEqual([...DEFAULT_EXCLUDED_WORDS]);
      expect(settings.links.excludedDomains).toEqual([...DEFAULT_EXCLUDED_DOMAINS]);
    });

    it('ne partage pas les tableaux par défaut entre deux instances', () => {
      // Sans copie, modifier les réglages d'un profil altérerait ceux de tous
      // les autres — un partage de référence silencieux.
      const a = defaultAnalysisSettings();
      const b = defaultAnalysisSettings();
      a.hn.excludedWords.push('polluant');
      expect(b.hn.excludedWords).not.toContain('polluant');
    });
  });

  describe('pollution de prototype', () => {
    it.each(['__proto__', 'constructor', 'prototype'])(
      'REFUSE la clé %s dans checkWeights',
      key => {
        // Ces dictionnaires sont fusionnés plus tard dans des objets de
        // configuration : une telle clé transformerait une écriture de réglages
        // en pollution de prototype à l'échelle du processus.
        const result = AnalysisSettingsSchema.safeParse(
          valid({ checkWeights: JSON.parse(`{"${key}": 2}`) }),
        );
        expect(result.success).toBe(false);
      },
    );

    it.each(['__proto__', 'constructor', 'prototype'])(
      'REFUSE la clé %s dans subCheckPolarity',
      key => {
        const result = AnalysisSettingsSchema.safeParse(
          valid({ subCheckPolarity: JSON.parse(`{"${key}": "absent"}`) }),
        );
        expect(result.success).toBe(false);
      },
    );

    it('REFUSE explicitement un identifiant inconnu, au lieu de le supprimer en silence', () => {
      // `z.record` écarte par défaut toute clé qui ne satisfait pas son schéma,
      // sans rien signaler : un identifiant mal orthographié disparaissait et
      // l'administrateur croyait avoir enregistré un réglage inexistant.
      const result = AnalysisSettingsSchema.safeParse(valid({ checkWeights: { metas: 3 } }));
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('metas');
    });

    it('accepte des clés de critère légitimes', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ checkWeights: { METAS: 3, 'LOGO.alt_ok': 0 } }),
      );
      expect(result.success).toBe(true);
    });

    it.each([
      ['une chaîne', 'pas-un-objet'],
      ['un tableau', ['METAS']],
      ['null', null],
      ['un nombre', 42],
    ])('laisse passer %s au schéma sous-jacent, qui tranchera', (_label, raw) => {
      // Le contrôle des clés n'a de sens que sur un objet : pour tout le reste,
      // c'est au schéma de record de produire l'erreur de type.
      expect(AnalysisSettingsSchema.safeParse(valid({ checkWeights: raw })).success).toBe(false);
    });

    it('n’altère pas le prototype d’Object après une tentative', () => {
      AnalysisSettingsSchema.safeParse(valid({ checkWeights: JSON.parse('{"__proto__": 5}') }));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('5');
    });
  });

  describe('identifiants de critère', () => {
    it.each([
      ['METAS', 'critère simple'],
      ['HN_STRUCTURE', 'critère avec tiret bas'],
      ['LOGO.alt_ok', 'sous-critère'],
      ['OG.twitter_card_missing', 'sous-critère composé'],
    ])('accepte %s (%s)', id => {
      expect(AnalysisSettingsSchema.safeParse(valid({ enabledChecks: [id] })).success).toBe(true);
    });

    it.each([
      ['metas', 'minuscules'],
      ['ME TAS', 'espace'],
      ['METAS;DROP', 'ponctuation'],
      ['../etc/passwd', 'chemin'],
      ['<script>', 'balise'],
      ['', 'vide'],
    ])('refuse %s (%s)', id => {
      expect(AnalysisSettingsSchema.safeParse(valid({ enabledChecks: [id] })).success).toBe(false);
    });
  });

  describe('cohérence des intervalles', () => {
    it.each([
      ['meta.title', { meta: { title: { min: 80, max: 20 }, description: { min: 1, max: 2 } } }],
      [
        'meta.description',
        { meta: { title: { min: 1, max: 2 }, description: { min: 90, max: 20 } } },
      ],
      ['hn', { hn: { minLength: 90, maxLength: 10, excludedWords: [] } }],
      ['bold', { bold: { min: 9, max: 2, minParentWords: 0 } }],
    ])('refuse un intervalle inversé sur %s', (_label, patch) => {
      // Un intervalle inversé passe la validation champ par champ tout en
      // rendant le critère insatisfiable : aucune valeur n'est à la fois ≥ min
      // et ≤ max.
      expect(AnalysisSettingsSchema.safeParse(valid(patch)).success).toBe(false);
    });

    it('accepte un intervalle dégénéré où min égale max', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ bold: { min: 4, max: 4, minParentWords: 0 } }),
      );
      expect(result.success).toBe(true);
    });

    it('refuse un seuil d’avertissement d’image au-dessus du seuil d’échec', () => {
      // Il ne se déclencherait jamais.
      const result = AnalysisSettingsSchema.safeParse(
        valid({ images: { maxSizeBytes: 1000, warningThresholdBytes: 5000, maxRatio: 3 } }),
      );
      expect(result.success).toBe(false);
    });

    it('refuse un seuil d’avertissement de contenu sous le minimum de mots', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ content: { minWords: 800, warningWords: 300 } }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('mass assignment', () => {
    it('REJETTE une clé surnuméraire à la racine', () => {
      expect(AnalysisSettingsSchema.safeParse(valid({ inconnu: 1 })).success).toBe(false);
    });

    it('rejette une clé surnuméraire dans un sous-objet', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ content: { minWords: 1, warningWords: 2, bonus: true } }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('bornes', () => {
    it('refuse une pondération hors de l’échelle 0–5', () => {
      expect(AnalysisSettingsSchema.safeParse(valid({ checkWeights: { METAS: 9 } })).success).toBe(
        false,
      );
      expect(AnalysisSettingsSchema.safeParse(valid({ checkWeights: { METAS: -1 } })).success).toBe(
        false,
      );
    });

    it('accepte les bornes exactes de la pondération', () => {
      expect(AnalysisSettingsSchema.safeParse(valid({ checkWeights: { METAS: 0 } })).success).toBe(
        true,
      );
      expect(AnalysisSettingsSchema.safeParse(valid({ checkWeights: { METAS: 5 } })).success).toBe(
        true,
      );
    });

    it('borne la taille des listes — une liste non bornée est un levier de déni de service', () => {
      const enorme = Array.from({ length: 5000 }, (_, i) => `CHECK_${i}`);
      expect(AnalysisSettingsSchema.safeParse(valid({ enabledChecks: enorme })).success).toBe(
        false,
      );
    });

    it('refuse un délai de liens négatif', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ links: { timeout: -1, excludedDomains: [] } }),
      );
      expect(result.success).toBe(false);
    });

    it('refuse une valeur non entière là où un entier est attendu', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ content: { minWords: 1.5, warningWords: 2 } }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('anchorText', () => {
    it('accepte une surcharge partielle', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ anchorText: { enabled: false, concordanceThreshold: 80 } }),
      );
      expect(result.success).toBe(true);
    });

    it('refuse un seuil de concordance hors de 0–100', () => {
      const result = AnalysisSettingsSchema.safeParse(
        valid({ anchorText: { concordanceThreshold: 150 } }),
      );
      expect(result.success).toBe(false);
    });
  });
});

describe('PageRuleSchema', () => {
  it('accepte une règle complète', () => {
    const result = PageRuleSchema.safeParse({
      label: 'Pages produit',
      patterns: ['/produit/*'],
      disabledChecks: ['METAS'],
      settings: { content: { minWords: 100 }, h1: { minLength: 10, maxLength: 70 } },
    });
    expect(result.success).toBe(true);
  });

  it('exige un libellé non vide', () => {
    expect(PageRuleSchema.safeParse({ label: '', patterns: [] }).success).toBe(false);
  });

  it('rejette une clé surnuméraire', () => {
    expect(PageRuleSchema.safeParse({ label: 'x', patterns: [], inattendu: true }).success).toBe(
      false,
    );
  });

  it('borne le nombre de motifs', () => {
    const motifs = Array.from({ length: 500 }, (_, i) => `/p${i}`);
    expect(PageRuleSchema.safeParse({ label: 'x', patterns: motifs }).success).toBe(false);
  });
});
