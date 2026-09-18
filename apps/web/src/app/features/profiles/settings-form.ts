import { FormBuilder, Validators, type FormGroup } from '@angular/forms';
import type { AnalysisSettings } from '@websentry/shared';

/**
 * Formulaire réactif des réglages d'analyse.
 *
 * Les bornes reprennent EXACTEMENT celles du schéma Zod partagé : l'utilisateur
 * est averti avant l'appel réseau, et le serveur revalide de toute façon. Les
 * faire diverger produirait soit un refus incompréhensible côté serveur, soit
 * une permissivité trompeuse côté client.
 *
 * Toutes les clés des réglages ne sont pas éditables ici : les listes longues
 * (mots exclus, domaines exclus, règles par page) et les dictionnaires de
 * pondération sont conservés TELS QUELS et réinjectés à l'enregistrement.
 * Sans cela, ouvrir puis enregistrer un profil l'amputerait silencieusement.
 */

export type SettingsFormGroup = ReturnType<typeof buildSettingsForm>;

export function buildSettingsForm(fb: FormBuilder) {
  const intField = (min: number, max: number) =>
    fb.nonNullable.control(0, [Validators.required, Validators.min(min), Validators.max(max)]);

  return fb.nonNullable.group({
    metaTitleMin: intField(0, 1000),
    metaTitleMax: intField(1, 1000),
    metaDescriptionMin: intField(0, 1000),
    metaDescriptionMax: intField(1, 1000),

    hnMinLength: intField(0, 1000),
    hnMaxLength: intField(1, 1000),

    boldMin: intField(0, 1000),
    boldMax: intField(1, 1000),
    boldMinParentWords: intField(0, 10_000),

    imagesMaxSizeBytes: intField(0, 1_000_000_000),
    imagesWarningThresholdBytes: intField(0, 1_000_000_000),
    imagesMaxRatio: fb.nonNullable.control(0, [Validators.min(0), Validators.max(1000)]),

    linksTimeout: intField(0, 600_000),

    contentMinWords: intField(0, 100_000),
    contentWarningWords: intField(0, 100_000),

    detectRegressions: fb.nonNullable.control(false),
  });
}

/** Alimente le formulaire depuis des réglages complets. */
export function patchFormFromSettings(form: SettingsFormGroup, settings: AnalysisSettings): void {
  form.patchValue({
    metaTitleMin: settings.meta.title.min,
    metaTitleMax: settings.meta.title.max,
    metaDescriptionMin: settings.meta.description.min,
    metaDescriptionMax: settings.meta.description.max,

    hnMinLength: settings.hn.minLength,
    hnMaxLength: settings.hn.maxLength,

    boldMin: settings.bold.min,
    boldMax: settings.bold.max,
    boldMinParentWords: settings.bold.minParentWords,

    imagesMaxSizeBytes: settings.images.maxSizeBytes,
    imagesWarningThresholdBytes: settings.images.warningThresholdBytes,
    imagesMaxRatio: settings.images.maxRatio,

    linksTimeout: settings.links.timeout,

    contentMinWords: settings.content.minWords,
    contentWarningWords: settings.content.warningWords,

    detectRegressions: settings.detectRegressions ?? false,
  });
}

/**
 * Reconstruit des réglages complets à partir du formulaire.
 *
 * `base` fournit tout ce que le formulaire n'édite pas — listes, règles par
 * page, pondérations. Repartir d'un objet vide effacerait ces réglages à la
 * première sauvegarde.
 */
export function settingsFromForm(
  form: SettingsFormGroup,
  base: AnalysisSettings,
  enabledChecks: readonly string[],
): AnalysisSettings {
  const v = form.getRawValue();

  return {
    ...base,
    meta: {
      title: { min: v.metaTitleMin, max: v.metaTitleMax },
      description: { min: v.metaDescriptionMin, max: v.metaDescriptionMax },
    },
    hn: {
      ...base.hn,
      minLength: v.hnMinLength,
      maxLength: v.hnMaxLength,
    },
    bold: {
      min: v.boldMin,
      max: v.boldMax,
      minParentWords: v.boldMinParentWords,
    },
    images: {
      maxSizeBytes: v.imagesMaxSizeBytes,
      warningThresholdBytes: v.imagesWarningThresholdBytes,
      maxRatio: v.imagesMaxRatio,
    },
    links: {
      ...base.links,
      timeout: v.linksTimeout,
    },
    content: {
      minWords: v.contentMinWords,
      warningWords: v.contentWarningWords,
    },
    detectRegressions: v.detectRegressions,
    enabledChecks: [...enabledChecks],
  };
}

/** Une incohérence d'intervalle, telle qu'affichée à l'utilisateur. */
export interface RangeIssue {
  field: string;
  message: string;
}

/**
 * Contrôles CROISÉS entre champs.
 *
 * Les validateurs Angular portent sur un champ isolé ; la cohérence d'un
 * intervalle met deux champs en relation. Ces règles reproduisent celles du
 * `superRefine` côté schéma partagé.
 */
export function rangeIssues(form: SettingsFormGroup): RangeIssue[] {
  const v = form.getRawValue();
  const issues: RangeIssue[] = [];

  const ordered: Array<[string, number, number, string]> = [
    ['metaTitleMax', v.metaTitleMin, v.metaTitleMax, 'titre'],
    ['metaDescriptionMax', v.metaDescriptionMin, v.metaDescriptionMax, 'méta description'],
    ['hnMaxLength', v.hnMinLength, v.hnMaxLength, 'titres Hn'],
    ['boldMax', v.boldMin, v.boldMax, 'mises en gras'],
  ];

  for (const [field, min, max, label] of ordered) {
    if (min > max) {
      issues.push({
        field,
        message: `Intervalle ${label} inversé : le minimum dépasse le maximum`,
      });
    }
  }

  if (v.imagesWarningThresholdBytes > v.imagesMaxSizeBytes) {
    issues.push({
      field: 'imagesWarningThresholdBytes',
      message:
        "Le seuil d'avertissement doit rester sous le poids maximal, sinon il ne se déclenche jamais",
    });
  }

  if (v.contentMinWords > v.contentWarningWords) {
    issues.push({
      field: 'contentWarningWords',
      message: "Le seuil d'avertissement doit être au moins égal au minimum de mots",
    });
  }

  return issues;
}

/** Vrai si le formulaire est valide ET cohérent. */
export function isFormSubmittable(form: FormGroup): boolean {
  return form.valid && rangeIssues(form as SettingsFormGroup).length === 0;
}
