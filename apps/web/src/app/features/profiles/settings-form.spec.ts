import { FormBuilder } from '@angular/forms';
import { defaultAnalysisSettings, type AnalysisSettings } from '@websentry/shared';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildSettingsForm,
  isFormSubmittable,
  patchFormFromSettings,
  rangeIssues,
  settingsFromForm,
  type EditedCollections,
  type SettingsFormGroup,
} from './settings-form';

/** Collections éditées hors formulaire — vides sauf mention contraire. */
function editees(over: Partial<EditedCollections> = {}): EditedCollections {
  return {
    enabledChecks: [],
    excludedWords: [],
    excludedDomains: [],
    checkWeights: {},
    pageRules: [],
    ...over,
  };
}

describe('formulaire des réglages', () => {
  let form: SettingsFormGroup;

  beforeEach(() => {
    form = buildSettingsForm(new FormBuilder());
    patchFormFromSettings(form, defaultAnalysisSettings());
  });

  describe('alimentation', () => {
    it('reprend les valeurs des réglages', () => {
      const v = form.getRawValue();
      expect(v.metaTitleMin).toBe(50);
      expect(v.metaTitleMax).toBe(65);
      expect(v.contentMinWords).toBe(300);
      expect(v.linksTimeout).toBe(10_000);
    });

    it('traite l’absence de détection de régressions comme un refus', () => {
      const settings = { ...defaultAnalysisSettings() };
      delete (settings as Partial<AnalysisSettings>).detectRegressions;
      patchFormFromSettings(form, settings);
      expect(form.getRawValue().detectRegressions).toBe(false);
    });
  });

  describe('reconstruction', () => {
    it('produit des réglages acceptés par le schéma partagé', () => {
      const base = defaultAnalysisSettings();
      const rebuilt = settingsFromForm(form, base, editees({ enabledChecks: ['METAS'] }));
      // Le contrat client et le contrat serveur sont le même schéma : ce qui
      // sort du formulaire doit passer la validation du serveur.
      expect(() => structuredClone(rebuilt)).not.toThrow();
      expect(rebuilt.meta.title).toEqual({ min: 50, max: 65 });
      expect(rebuilt.enabledChecks).toEqual(['METAS']);
    });

    it('CONSERVE ce qui n’est éditable NULLE PART', () => {
      // Polarité des sous-critères et exclusions d'orphelins n'ont pas encore
      // d'écran : sans ce report, ouvrir puis enregistrer les effacerait.
      const base: AnalysisSettings = {
        ...defaultAnalysisSettings(),
        orphanExclusions: ['/mentions-legales'],
        subCheckPolarity: { 'METAS.title': 'absent' },
      };

      const rebuilt = settingsFromForm(form, base, editees());

      expect(rebuilt.orphanExclusions).toEqual(['/mentions-legales']);
      expect(rebuilt.subCheckPolarity).toEqual({ 'METAS.title': 'absent' });
    });

    it('reprend les RÈGLES PAR PAGE éditées, et retire la clé quand il n’y en a plus', () => {
      // Réinjecter celles du profil lu annulerait en silence chaque
      // suppression ; écrire un tableau vide gonflerait le profil d'une clé
      // qui ne dit rien.
      const base: AnalysisSettings = {
        ...defaultAnalysisSettings(),
        pageRules: [{ label: 'Ancienne', patterns: ['/vieux'] }],
      };

      const avec = settingsFromForm(form, base, {
        ...editees(),
        pageRules: [{ label: 'Contact', patterns: ['contact'] }],
      });
      const sans = settingsFromForm(form, base, editees());

      expect(avec.pageRules).toEqual([{ label: 'Contact', patterns: ['contact'] }]);
      expect('pageRules' in sans).toBe(false);
    });

    it('reprend les listes ÉDITÉES, et non celles d’origine', () => {
      // La liste vient désormais de l'écran : réinjecter celle de `base`
      // annulerait en silence chaque retrait fait par l'utilisateur.
      const base = defaultAnalysisSettings();

      const rebuilt = settingsFromForm(
        form,
        base,
        editees({ excludedWords: ['le'], excludedDomains: ['exemple.fr'] }),
      );

      expect(rebuilt.hn.excludedWords).toEqual(['le']);
      expect(rebuilt.links.excludedDomains).toEqual(['exemple.fr']);
    });

    it('N’ÉCRIT que les pondérations qui s’écartent du défaut', () => {
      // Écrire un coefficient 1 pour les vingt-neuf critères gonflerait le
      // profil d'un dictionnaire qui ne dit rien, et masquerait les trois
      // réglages qui, eux, veulent dire quelque chose.
      const rebuilt = settingsFromForm(
        form,
        defaultAnalysisSettings(),
        editees({ checkWeights: { METAS: 2, LINKS: 1, IMAGES: 0 } }),
      );

      expect(rebuilt.checkWeights).toEqual({ METAS: 2, IMAGES: 0 });
    });

    it('n’écrit aucune clé de pondération quand rien ne s’écarte du défaut', () => {
      const rebuilt = settingsFromForm(
        form,
        defaultAnalysisSettings(),
        editees({ checkWeights: { METAS: 1, LINKS: 1 } }),
      );

      expect('checkWeights' in rebuilt).toBe(false);
    });

    it('EFFACE une pondération que le profil portait et qu’on a ramenée au défaut', () => {
      // Le socle est recopié tel quel : sans retrait explicite, l'ancienne
      // valeur survivrait et la remise à « Normal » n'aurait aucun effet.
      const base: AnalysisSettings = { ...defaultAnalysisSettings(), checkWeights: { METAS: 2 } };

      const rebuilt = settingsFromForm(form, base, editees({ checkWeights: { METAS: 1 } }));

      expect('checkWeights' in rebuilt).toBe(false);
    });

    it('reprend les valeurs saisies', () => {
      form.patchValue({ contentMinWords: 120, contentWarningWords: 400, boldMin: 1, boldMax: 9 });
      const rebuilt = settingsFromForm(form, defaultAnalysisSettings(), editees());
      expect(rebuilt.content).toEqual({ minWords: 120, warningWords: 400 });
      expect(rebuilt.bold.min).toBe(1);
      expect(rebuilt.bold.max).toBe(9);
    });
  });

  describe('contrôles croisés', () => {
    it('ne signale rien sur des valeurs cohérentes', () => {
      expect(rangeIssues(form)).toEqual([]);
    });

    it.each([
      ['metaTitleMax', { metaTitleMin: 90, metaTitleMax: 10 }],
      ['metaDescriptionMax', { metaDescriptionMin: 200, metaDescriptionMax: 20 }],
      ['hnMaxLength', { hnMinLength: 90, hnMaxLength: 10 }],
      ['boldMax', { boldMin: 9, boldMax: 2 }],
    ])('signale un intervalle inversé sur %s', (field, patch) => {
      form.patchValue(patch);
      expect(rangeIssues(form).map(i => i.field)).toContain(field);
    });

    it('accepte un intervalle dégénéré où min égale max', () => {
      form.patchValue({ boldMin: 4, boldMax: 4 });
      expect(rangeIssues(form).map(i => i.field)).not.toContain('boldMax');
    });

    it('signale un seuil d’avertissement d’image au-dessus du seuil d’échec', () => {
      form.patchValue({ imagesMaxSizeBytes: 1000, imagesWarningThresholdBytes: 5000 });
      expect(rangeIssues(form).map(i => i.field)).toContain('imagesWarningThresholdBytes');
    });

    it('signale un seuil d’avertissement de contenu sous le minimum de mots', () => {
      form.patchValue({ contentMinWords: 900, contentWarningWords: 100 });
      expect(rangeIssues(form).map(i => i.field)).toContain('contentWarningWords');
    });

    it('cumule plusieurs incohérences', () => {
      form.patchValue({ metaTitleMin: 90, metaTitleMax: 10, boldMin: 9, boldMax: 2 });
      expect(rangeIssues(form)).toHaveLength(2);
    });

    it('reprend EXACTEMENT les règles du schéma partagé', () => {
      // Une divergence produirait soit un refus serveur incompréhensible, soit
      // une permissivité trompeuse côté client.
      form.patchValue({ metaTitleMin: 90, metaTitleMax: 10 });
      const rebuilt = settingsFromForm(form, defaultAnalysisSettings(), editees());

      expect(rangeIssues(form).length).toBeGreaterThan(0);
      expect(rebuilt.meta.title.min).toBeGreaterThan(rebuilt.meta.title.max);
    });
  });

  describe('bornes des champs', () => {
    it('refuse une valeur négative', () => {
      form.patchValue({ contentMinWords: -5 });
      expect(form.controls.contentMinWords.valid).toBe(false);
    });

    it('refuse une valeur au-delà du plafond', () => {
      form.patchValue({ linksTimeout: 900_000 });
      expect(form.controls.linksTimeout.valid).toBe(false);
    });

    it('accepte les bornes exactes', () => {
      form.patchValue({ linksTimeout: 600_000, contentMinWords: 0 });
      expect(form.controls.linksTimeout.valid).toBe(true);
      expect(form.controls.contentMinWords.valid).toBe(true);
    });
  });

  describe('isFormSubmittable', () => {
    it('accepte un formulaire valide et cohérent', () => {
      expect(isFormSubmittable(form)).toBe(true);
    });

    it('refuse un formulaire aux bornes dépassées', () => {
      form.patchValue({ linksTimeout: 900_000 });
      expect(isFormSubmittable(form)).toBe(false);
    });

    it('refuse un formulaire valide mais INCOHÉRENT', () => {
      // Chaque champ respecte ses bornes ; c'est leur relation qui ne va pas.
      form.patchValue({ metaTitleMin: 90, metaTitleMax: 10 });
      expect(form.valid).toBe(true);
      expect(isFormSubmittable(form)).toBe(false);
    });
  });
});
