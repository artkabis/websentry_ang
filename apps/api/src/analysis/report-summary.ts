import type { CheckSummary, CheckResult } from '@websentry/shared';

/**
 * Résumé {critère → statut} d'un rapport — fonction PURE.
 *
 * C'est la seule partie du rapport que la rétention ne purge JAMAIS : elle
 * survit au rapport complet et rend deux scans anciens encore comparables des
 * années plus tard (cf. module 3). Elle doit donc rester minuscule — un statut
 * par critère, rien d'autre.
 */
export function toCheckSummary(checks: Record<string, CheckResult>): CheckSummary {
  const summary: CheckSummary = {};
  for (const [checkId, result] of Object.entries(checks)) {
    summary[checkId] = result.status;
  }
  return summary;
}
