import { z } from 'zod';
import {
  CheckStatusSchema,
  ScanUuidSchema,
  ScoreSchema,
  type CheckStatus,
  type CheckSummary,
} from './schemas/scan.schema.js';

/**
 * Comparaison de deux scans — règles métier partagées backend et frontend.
 *
 * Le backend s'en sert pour produire le diff ; le frontend le rejoue pour trier
 * et regrouper sans redemander au serveur. Une seule implémentation, donc une
 * seule définition de ce que « régresser » veut dire.
 */

// ── Ordre de santé ───────────────────────────────────────────────────────────

/**
 * Ordre de santé des statuts, du pire au meilleur.
 *
 * `na` porte volontairement une valeur hors échelle : « non applicable » n'est
 * pas un mauvais résultat, c'est l'ABSENCE de résultat. Le traiter comme un
 * échec ferait apparaître une régression massive le jour où un critère devient
 * inapplicable — un changement de périmètre déguisé en effondrement de qualité.
 */
export const CHECK_HEALTH_ORDER: Readonly<Record<CheckStatus, number>> = {
  fail: 0,
  warning: 1,
  info: 2,
  pass: 3,
  na: -1,
};

export const CheckTrendSchema = z.enum(['improved', 'degraded', 'stable', 'ignored']);
export type CheckTrend = z.infer<typeof CheckTrendSchema>;

/**
 * Tendance d'un critère entre deux scans.
 *
 * Toute transition impliquant `na` est `ignored` : sans base de comparaison
 * commune, le rapprochement n'a pas de sens.
 */
export function compareStatus(base: CheckStatus, target: CheckStatus): CheckTrend {
  if (base === 'na' || target === 'na') return 'ignored';
  const from = CHECK_HEALTH_ORDER[base];
  const to = CHECK_HEALTH_ORDER[target];
  if (to < from) return 'degraded';
  if (to > from) return 'improved';
  return 'stable';
}

// ── Diff d'un critère ────────────────────────────────────────────────────────

export const CheckDiffSchema = z
  .object({
    checkId: z.string().max(80),
    baseStatus: CheckStatusSchema,
    targetStatus: CheckStatusSchema,
    trend: CheckTrendSchema,
  })
  .strict();

export type CheckDiff = z.infer<typeof CheckDiffSchema>;

/**
 * Compare deux résumés de critères.
 *
 * Contrairement à la v1, qui ne remontait QUE les dégradations, le diff porte
 * ici les deux sens. Masquer les améliorations évite le bruit pendant une
 * analyse, mais dans un écran d'historique dont le sujet est précisément
 * l'évolution, cela revient à ne montrer que la moitié de l'information — et à
 * laisser croire qu'un site ne progresse jamais. Le tri par tendance est un
 * choix d'affichage, pas de contrat.
 *
 * Les critères absents de l'un des deux côtés sont écartés : un critère ajouté
 * au référentiel entre les deux scans n'est ni un gain ni une perte.
 */
export function compareCheckSummaries(base: CheckSummary, target: CheckSummary): CheckDiff[] {
  const diffs: CheckDiff[] = [];

  for (const checkId of Object.keys(base)) {
    const baseStatus = base[checkId];
    const targetStatus = target[checkId];
    if (baseStatus === undefined || targetStatus === undefined) continue;

    const trend = compareStatus(baseStatus, targetStatus);
    if (trend === 'ignored' || trend === 'stable') continue;
    diffs.push({ checkId, baseStatus, targetStatus, trend });
  }

  // Dégradations d'abord — c'est ce qu'on vient chercher — puis ordre stable
  // par identifiant pour que deux appels produisent exactement la même liste.
  return diffs.sort((a, b) => {
    if (a.trend !== b.trend) return a.trend === 'degraded' ? -1 : 1;
    return a.checkId.localeCompare(b.checkId);
  });
}

// ── Diff d'une page ──────────────────────────────────────────────────────────

export const PageChangeSchema = z.enum(['added', 'removed', 'changed', 'unchanged']);
export type PageChange = z.infer<typeof PageChangeSchema>;

export const PageDiffSchema = z
  .object({
    url: z.string().max(2048),
    change: PageChangeSchema,
    baseScore: ScoreSchema.nullable(),
    targetScore: ScoreSchema.nullable(),
    /** Écart de score, arrondi au dixième. `null` dès qu'un des deux côtés manque. */
    scoreDelta: z.number().nullable(),
    degraded: z.number().int().min(0),
    improved: z.number().int().min(0),
    checks: z.array(CheckDiffSchema),
  })
  .strict();

export type PageDiff = z.infer<typeof PageDiffSchema>;

/** Ce que la comparaison a besoin de connaître d'une page — rien de plus. */
export interface ComparablePage {
  url: string;
  globalScore: number | null;
  checkSummary: CheckSummary;
}

/** Arrondi au dixième — l'échelle des scores est 0–5, le centième est du bruit. */
function roundDelta(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Diff d'une session ───────────────────────────────────────────────────────

export const SessionDiffSummarySchema = z
  .object({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    degraded: z.number().int().min(0),
    improved: z.number().int().min(0),
    unchanged: z.number().int().min(0),
  })
  .strict();

export type SessionDiffSummary = z.infer<typeof SessionDiffSummarySchema>;

export const SessionSideSchema = z
  .object({
    sessionId: ScanUuidSchema,
    analyzedAt: z.string(),
    avgScore: ScoreSchema.nullable(),
    pageCount: z.number().int().min(0),
  })
  .strict();

export const SessionComparisonSchema = z
  .object({
    base: SessionSideSchema,
    target: SessionSideSchema,
    scoreDelta: z.number().nullable(),
    summary: SessionDiffSummarySchema,
    pages: z.array(PageDiffSchema),
  })
  .strict();

export type SessionComparison = z.infer<typeof SessionComparisonSchema>;

/**
 * Compare page à page deux sessions du même site.
 *
 * L'appariement se fait sur l'URL : c'est la seule clé stable entre deux
 * lancements, les identifiants de page étant régénérés à chaque scan. Une URL
 * présente d'un seul côté est signalée comme ajoutée ou retirée plutôt que
 * silencieusement écartée — un site qui perd la moitié de ses pages entre deux
 * audits est un fait à montrer, pas un détail d'appariement.
 *
 * `base` est le scan ANCIEN, `target` le RÉCENT : un delta négatif est donc une
 * dégradation, dans le même sens que la lecture naturelle « ça a baissé ».
 */
export function comparePages(
  basePages: readonly ComparablePage[],
  targetPages: readonly ComparablePage[],
): { pages: PageDiff[]; summary: SessionDiffSummary } {
  const baseByUrl = new Map(basePages.map(p => [p.url, p]));
  const targetByUrl = new Map(targetPages.map(p => [p.url, p]));

  const diffs: PageDiff[] = [];
  const summary: SessionDiffSummary = {
    added: 0,
    removed: 0,
    degraded: 0,
    improved: 0,
    unchanged: 0,
  };

  for (const [url, target] of targetByUrl) {
    const base = baseByUrl.get(url);

    if (!base) {
      summary.added += 1;
      diffs.push({
        url,
        change: 'added',
        baseScore: null,
        targetScore: target.globalScore,
        scoreDelta: null,
        degraded: 0,
        improved: 0,
        checks: [],
      });
      continue;
    }

    const checks = compareCheckSummaries(base.checkSummary, target.checkSummary);
    const degraded = checks.filter(c => c.trend === 'degraded').length;
    const improved = checks.length - degraded;
    const scoreDelta =
      base.globalScore != null && target.globalScore != null
        ? roundDelta(target.globalScore - base.globalScore)
        : null;

    // Une page est « changée » dès qu'un critère bouge OU que le score bouge :
    // le score peut varier par pondération sans qu'aucun statut ne change.
    const changed = checks.length > 0 || (scoreDelta != null && scoreDelta !== 0);
    if (changed) {
      if (degraded > 0 || (scoreDelta != null && scoreDelta < 0)) summary.degraded += 1;
      else summary.improved += 1;
    } else {
      summary.unchanged += 1;
    }

    diffs.push({
      url,
      change: changed ? 'changed' : 'unchanged',
      baseScore: base.globalScore,
      targetScore: target.globalScore,
      scoreDelta,
      degraded,
      improved,
      checks,
    });
  }

  for (const [url, base] of baseByUrl) {
    if (targetByUrl.has(url)) continue;
    summary.removed += 1;
    diffs.push({
      url,
      change: 'removed',
      baseScore: base.globalScore,
      targetScore: null,
      scoreDelta: null,
      degraded: 0,
      improved: 0,
      checks: [],
    });
  }

  // Les pages qui ont perdu le plus arrivent en tête ; à égalité, l'URL tranche
  // pour que l'ordre ne dépende pas de celui des lignes en base.
  diffs.sort((a, b) => {
    const rank = (d: PageDiff): number => {
      if (d.change === 'removed') return -2;
      if (d.change === 'added') return -1;
      return 0;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = a.scoreDelta ?? 0;
    const db = b.scoreDelta ?? 0;
    if (da !== db) return da - db;
    if (a.degraded !== b.degraded) return b.degraded - a.degraded;
    return a.url.localeCompare(b.url);
  });

  return { pages: diffs, summary };
}
