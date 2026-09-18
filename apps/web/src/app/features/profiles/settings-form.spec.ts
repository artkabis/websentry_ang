import { FormBuilder } from '@angular/forms';
import { defaultAnalysisSettings, type AnalysisSettings } from '@websentry/shared';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildSettingsForm,
  isFormSubmittable,
  patchFormFromSettings,
  rangeIssues,
  settingsFromForm,
  type SettingsFormGroup,
} from './settings-form';

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
      const rebuilt = settingsFromForm(form, base, ['METAS']);
      // Le contrat client et le contrat serveur sont le même schéma : ce qui
      // sort du formulaire doit passer la validation du serveur.
      expect(() => structuredClone(rebuilt)).not.toThrow();
      expect(rebuilt.meta.title).toEqual({ min: 50, max: 65 });
      expect(rebuilt.enabledChecks).toEqual(['METAS']);
    });

    it('CONSERVE les réglages que le formulaire n’édite pas', () => {
      // Sans cela, ouvrir puis enregistrer un profil l'amputerait de ses listes
      // et de ses règles par page.
      const base: AnalysisSettings = {
        ...defaultAnalysisSettings(),
        pageRules: [{ label: 'Produits', patterns: ['/p/*'] }],
        checkWeights: { METAS: 2 },
        orphanExclusions: ['/mentions-legales'],
      };

      const rebuilt = settingsFromForm(form, base, []);

      expect(rebuilt.pageRules).toEqual(base.pageRules);
      expect(rebuilt.checkWeights).toEqual({ METAS: 2 });
      expect(rebuilt.orphanExclusions).toEqual(['/mentions-legales']);
    });

    it('conserve les listes de mots et de domaines exclus', () => {
      const base = defaultAnalysisSettings();
      const rebuilt = settingsFromForm(form, base, []);
      expect(rebuilt.hn.excludedWords).toEqual(base.hn.excludedWords);
      expect(rebuilt.links.excludedDomains).toEqual(base.links.excludedDomains);
    });

    it('reprend les valeurs saisies', () => {
      form.patchValue({ contentMinWords: 120, contentWarningWords: 400, boldMin: 1, boldMax: 9 });
      const rebuilt = settingsFromForm(form, defaultAnalysisSettings(), []);
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
      const rebuilt = settingsFromForm(form, defaultAnalysisSettings(), []);

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
