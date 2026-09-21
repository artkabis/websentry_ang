import { FormBuilder, Validators, type FormGroup } from '@angular/forms';
import { DEFAULT_CHECK_WEIGHT, type AnalysisSettings, type PageRule } from '@websentry/shared';

/**
 * Formulaire réactif des réglages d'analyse.
 *
 * Les bornes reprennent EXACTEMENT celles du schéma Zod partagé : l'utilisateur
 * est averti avant l'appel réseau, et le serveur revalide de toute façon. Les
 * faire diverger produirait soit un refus incompréhensible côté serveur, soit
 * une permissivité trompeuse côté client.
 *
 * Les listes longues et les pondérations ne sont pas des contrôles de ce
 * formulaire : elles sont éditées par des composants dédiés et passées ici au
 * moment de reconstruire les réglages. Tout ce qui n'est éditable NULLE PART —
 * règles par page, polarité des sous-critères, exclusions d'orphelins — est
 * conservé tel quel depuis `base` : sans cela, ouvrir puis enregistrer un
 * profil l'amputerait silencieusement.
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
 * `base` fournit tout ce qui n'est éditable nulle part — polarité des
 * sous-critères, exclusions d'orphelins. Repartir d'un objet vide effacerait
 * ces réglages à la première sauvegarde.
 */
export interface EditedCollections {
  enabledChecks: readonly string[];
  excludedWords: readonly string[];
  excludedDomains: readonly string[];
  /** Surcharges de pondération ; une entrée au poids par défaut est omise. */
  checkWeights: Readonly<Record<string, number>>;
  pageRules: readonly PageRule[];
}

export function settingsFromForm(
  form: SettingsFormGroup,
  base: AnalysisSettings,
  edited: EditedCollections,
): AnalysisSettings {
  const v = form.getRawValue();
  const checkWeights = Object.fromEntries(
    Object.entries(edited.checkWeights).filter(([, poids]) => poids !== DEFAULT_CHECK_WEIGHT),
  );

  // Les clés optionnelles éditées sont RETIRÉES du socle avant d'être
  // réécrites : sans cela, vider complètement les pondérations ou les règles
  // par page laisserait survivre celles du profil lu, et la suppression
  // n'aurait aucun effet visible avant le rechargement.
  const { checkWeights: _poids, pageRules: _regles, ...socle } = base;

  return {
    ...socle,
    meta: {
      title: { min: v.metaTitleMin, max: v.metaTitleMax },
      description: { min: v.metaDescriptionMin, max: v.metaDescriptionMax },
    },
    hn: {
      ...base.hn,
      minLength: v.hnMinLength,
      maxLength: v.hnMaxLength,
      excludedWords: [...edited.excludedWords],
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
      excludedDomains: [...edited.excludedDomains],
    },
    content: {
      minWords: v.contentMinWords,
      warningWords: v.contentWarningWords,
    },
    detectRegressions: v.detectRegressions,
    enabledChecks: [...edited.enabledChecks],
    // Une liste vide n'est pas la même chose qu'une absence de règles : la clé
    // disparaît plutôt que de porter un tableau creux.
    ...(edited.pageRules.length > 0 ? { pageRules: [...edited.pageRules] } : {}),
    // Un dictionnaire vide n'est pas la même chose qu'une absence de
    // surcharges : la clé disparaît plutôt que de porter un objet creux.
    ...(Object.keys(checkWeights).length > 0 ? { checkWeights } : {}),
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
