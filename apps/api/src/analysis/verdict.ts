import type { CheckItem, CheckStatus } from '@websentry/shared';

/**
 * Verdict d'un critère à partir de ses items — fonction PURE.
 *
 * La v1 recopiait `failCount > 0 ? 1 : warnCount > 0 ? 3 : 5` dans une
 * quinzaine d'analyseurs, avec des variantes silencieuses d'un fichier à
 * l'autre. Une règle de notation recopiée quinze fois est une règle qui finit
 * par dire quinze choses différentes : elle vit ici, et se teste une fois.
 */
export interface Verdict {
  status: CheckStatus;
  globalScore: number;
  failures: number;
  warnings: number;
}

/** Barème par défaut : un échec pèse lourd, un avertissement coûte deux points. */
export const FAIL_SCORE = 1;
export const WARN_SCORE = 3;
export const PASS_SCORE = 5;

export function verdictOf(items: readonly CheckItem[]): Verdict {
  const failures = items.filter(item => item.status === 'fail').length;
  const warnings = items.filter(item => item.status === 'warning').length;

  if (failures > 0) return { status: 'fail', globalScore: FAIL_SCORE, failures, warnings };
  if (warnings > 0) return { status: 'warning', globalScore: WARN_SCORE, failures, warnings };
  return { status: 'pass', globalScore: PASS_SCORE, failures, warnings };
}

/**
 * Barème DÉGRESSIF, pour les critères qui comptent plusieurs défauts du même
 * type : trois images sans `alt` sont plus graves qu'une seule, là où une
 * canonical absente est un fait binaire.
 */
export function gradedVerdict(items: readonly CheckItem[]): Verdict {
  const failures = items.filter(item => item.status === 'fail').length;
  const warnings = items.filter(item => item.status === 'warning').length;

  if (failures > 0) {
    return { status: 'fail', globalScore: Math.max(0, 3 - failures), failures, warnings };
  }
  if (warnings > 0) {
    return { status: 'warning', globalScore: Math.max(2, 4 - warnings), failures, warnings };
  }
  return { status: 'pass', globalScore: PASS_SCORE, failures, warnings };
}
