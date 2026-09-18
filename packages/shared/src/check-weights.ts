/**
 * Pondération des critères — source de vérité partagée backend + frontend.
 *
 * Chaque critère porte un poids (coefficient) qui module son influence dans le score global.
 * Le score global devient une **moyenne pondérée** : `Σ(noteᵢ × poidsᵢ) / Σ(poidsᵢ)`.
 *
 * Deux niveaux de réglage cohabitent (modèle « palier par défaut + surcharge fine ») :
 *   1. Des paliers prédéfinis (tiers) que l'équipe qualité applique en un clic ;
 *   2. Une surcharge numérique libre (0–5) pour un ajustement fin par critère.
 *
 * Invariants :
 *   - Poids par défaut = 1 → moyenne pondérée ≡ moyenne simple (aucune régression).
 *   - Poids 0 → critère exclu du score (équivalent au mode « indicatif »).
 *   - Un critère en mode indicatif (`informationalChecks`) est toujours ramené à un poids 0,
 *     ce qui unifie l'exclusion du score entre backend et frontend.
 */

export const DEFAULT_CHECK_WEIGHT = 1;
export const MIN_CHECK_WEIGHT = 0;
export const MAX_CHECK_WEIGHT = 5;

export interface WeightTier {
  /** Identifiant stable du palier */
  id: 'critique' | 'important' | 'normal' | 'mineur' | 'informatif';
  /** Libellé affiché à l'équipe qualité */
  label: string;
  /** Coefficient appliqué */
  factor: number;
  /** Courte description du sens du palier */
  hint: string;
}

/** Paliers prédéfinis, du plus au moins influent. */
export const WEIGHT_TIERS: readonly WeightTier[] = [
  { id: 'critique', label: 'Critique', factor: 2, hint: 'Compte double dans le score' },
  { id: 'important', label: 'Important', factor: 1.5, hint: 'Influence renforcée' },
  { id: 'normal', label: 'Normal', factor: 1, hint: 'Poids standard (défaut)' },
  { id: 'mineur', label: 'Mineur', factor: 0.5, hint: 'Influence réduite' },
  { id: 'informatif', label: 'Informatif', factor: 0, hint: 'Exclu du score' },
] as const;

/** Retourne le palier exact correspondant à un coefficient, ou null si valeur intermédiaire. */
export function tierForWeight(weight: number): WeightTier | null {
  return WEIGHT_TIERS.find(t => t.factor === weight) ?? null;
}

/** Sous-ensemble de réglages nécessaire au calcul du poids effectif. */
export interface WeightAwareSettings {
  checkWeights?: Record<string, number>;
  informationalChecks?: string[];
}

/**
 * Poids effectif d'un critère : 0 si indicatif, sinon la surcharge `checkWeights` (bornée 0–5),
 * sinon le poids par défaut (1). Toute valeur invalide retombe sur le défaut.
 */
export function resolveCheckWeight(checkId: string, settings?: WeightAwareSettings | null): number {
  if (settings?.informationalChecks?.includes(checkId)) return 0;
  const raw = settings?.checkWeights?.[checkId];
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_CHECK_WEIGHT;
  if (raw < MIN_CHECK_WEIGHT) return MIN_CHECK_WEIGHT;
  if (raw > MAX_CHECK_WEIGHT) return MAX_CHECK_WEIGHT;
  return raw;
}

/**
 * Moyenne pondérée des notes des critères, en excluant les 'na' et les poids nuls.
 * Fallback à 5 quand aucun critère ne pèse dans le score.
 */
export function weightedGlobalScore(
  entries: ReadonlyArray<{ id: string; globalScore: number; status: string }>,
  settings?: WeightAwareSettings | null,
): number {
  let weightSum = 0;
  let acc = 0;
  for (const c of entries) {
    if (c.status === 'na') continue;
    const w = resolveCheckWeight(c.id, settings);
    if (w <= 0) continue;
    weightSum += w;
    acc += c.globalScore * w;
  }
  if (weightSum === 0) return 5;
  return Math.round((acc / weightSum) * 10) / 10;
}
