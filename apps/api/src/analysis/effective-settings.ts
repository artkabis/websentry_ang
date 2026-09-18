import type { AnalysisSettings } from '@websentry/shared';

/**
 * Réglages EFFECTIFS d'une analyse — profil, surcharges, règles par page.
 *
 * Type distinct des réglages persistés, et c'est délibéré. `hnByTag` naît d'une
 * règle par page et ne vaut que le temps d'une analyse : le loger dans
 * `AnalysisSettings` l'exposerait à l'écriture, où le schéma `.strict()` le
 * refuserait — ou pire, l'accepterait et le figerait dans le profil de toute
 * une gamme.
 *
 * La v1 l'y logeait malgré tout, en le documentant « jamais persisté ». Une
 * garantie tenue par un commentaire tient jusqu'à ce que quelqu'un ne le lise
 * pas ; ici, le type s'en charge.
 */
export interface EffectiveSettings extends AnalysisSettings {
  /** Surcharges de longueur par balise, produites par les règles par page. */
  hnByTag?: {
    h1?: { minLength?: number; maxLength?: number };
    h2?: { minLength?: number; maxLength?: number };
  };
}
