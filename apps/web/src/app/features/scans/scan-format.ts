import type { CheckStatus, ReportState, ScoreClass } from './scan-format.types';

/**
 * Mise en forme de l'historique — fonctions PURES, testables sans rendu.
 *
 * Elles portent les seuils et les libellés du domaine. Les garder hors des
 * gabarits évite qu'un seuil soit écrit deux fois, dans deux écrans, et finisse
 * par diverger.
 */

/** Seuils de l'échelle 0–5, alignés sur ceux du backend. */
export const SCORE_GOOD = 4;
export const SCORE_WARNING = 3;

/** Classe qualitative d'un score — pilote la couleur ET le libellé lu à voix haute. */
export function scoreClassOf(score: number | null): ScoreClass {
  if (score === null) return 'unknown';
  if (score >= SCORE_GOOD) return 'good';
  if (score >= SCORE_WARNING) return 'warning';
  return 'critical';
}

const SCORE_LABELS: Readonly<Record<ScoreClass, string>> = {
  good: 'bon',
  warning: 'à surveiller',
  critical: 'critique',
  unknown: 'non évalué',
};

/**
 * Libellé textuel d'un score.
 *
 * La couleur seule ne suffit pas : elle est invisible pour un lecteur d'écran
 * et ambiguë pour une personne daltonienne (WCAG 1.4.1, « l'information n'est
 * pas véhiculée par la couleur seule »).
 */
export function scoreLabelOf(score: number | null): string {
  return SCORE_LABELS[scoreClassOf(score)];
}

/** Score formaté pour l'affichage — « 4,2 » ou un tiret cadratin. */
export function formatScore(score: number | null): string {
  return score === null ? '—' : score.toFixed(1).replace('.', ',');
}

/** Écart de score, signe compris — le signe porte le sens, il n'est jamais omis. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  if (delta === 0) return '=';
  const formatted = Math.abs(delta).toFixed(1).replace('.', ',');
  return delta > 0 ? `+${formatted}` : `−${formatted}`;
}

const REPORT_STATE_LABELS: Readonly<Record<ReportState, string>> = {
  inline: 'Rapport disponible',
  compressed: 'Rapport archivé',
  purged: 'Rapport purgé',
};

/**
 * Libellé de l'état d'un rapport.
 *
 * « Purgé » et « archivé » ne veulent pas dire la même chose pour
 * l'utilisateur : le second se consulte normalement, le premier a disparu. Les
 * confondre — ce que faisait la v1, qui ne distinguait pas non plus « purgé »
 * de « introuvable » — envoie chercher une donnée qui n'existe plus.
 */
export function reportStateLabel(state: ReportState): string {
  return REPORT_STATE_LABELS[state];
}

/** Vrai si le rapport complet est encore consultable. */
export function reportAvailable(state: ReportState): boolean {
  return state !== 'purged';
}

const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: 'conforme',
  info: 'informatif',
  warning: 'à surveiller',
  fail: 'en échec',
  na: 'non applicable',
};

export function checkStatusLabel(status: CheckStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Résumé chiffré d'une session pour les lecteurs d'écran.
 *
 * Une ligne de tableau riche en colonnes se lit mal cellule par cellule : cette
 * phrase donne l'essentiel d'un coup, en `aria-label` sur le lien de la ligne.
 */
export function siteRowSummary(input: {
  domain: string;
  gamme: string | null;
  pageCount: number;
  avgScore: number | null;
}): string {
  const gamme = input.gamme ? `, gamme ${input.gamme}` : ', sans gamme';
  const score =
    input.avgScore === null
      ? 'score non évalué'
      : `score moyen ${formatScore(input.avgScore)} sur 5, ${scoreLabelOf(input.avgScore)}`;
  return `${input.domain}${gamme} — ${input.pageCount} page(s), ${score}`;
}

// ── Classes utilitaires ──────────────────────────────────────────────────────
//
// Les correspondances couleur vivent ICI et non dans chaque composant : le même
// badge de score apparaît dans la liste des sites et dans l'historique d'un
// site, et deux copies finissent toujours par diverger — un vert « bon » d'un
// côté, un autre de l'autre.

const SCORE_BADGE: Readonly<Record<ScoreClass, string>> = {
  good: 'bg-ok-surface text-ok-content',
  warning: 'bg-warn-surface text-warn-content',
  critical: 'bg-danger-surface text-danger-content',
  unknown: 'bg-sunken text-content-subtle',
};

/** Classes du badge de score. `extra` reçoit ce qui est propre à l'emplacement. */
export function scoreBadgeClass(score: number | null, extra = ''): string {
  const base = 'rounded-full px-2 py-0.5 text-xs font-medium';
  const suffix = extra ? ` ${extra}` : '';
  return `${base}${suffix} ${SCORE_BADGE[scoreClassOf(score)]}`;
}

/** Nature du changement d'une page entre deux audits. */
export type PageChange = 'added' | 'removed' | 'changed' | 'unchanged';

const CHANGE_LABELS: Readonly<Record<PageChange, string>> = {
  added: 'Apparue',
  removed: 'Disparue',
  changed: 'Modifiée',
  unchanged: 'Inchangée',
};

const CHANGE_BADGE: Readonly<Record<PageChange, string>> = {
  added: 'bg-info-surface text-info-content',
  removed: 'bg-line text-content-muted',
  changed: 'bg-warn-surface text-warn-content',
  unchanged: 'bg-sunken text-content-subtle',
};

export function changeLabel(change: PageChange): string {
  return CHANGE_LABELS[change];
}

export function changeBadgeClass(change: PageChange): string {
  return `shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${CHANGE_BADGE[change]}`;
}

/** Tendance d'un critère — seule la dégradation se distingue visuellement. */
export type CheckTrend = 'improved' | 'degraded' | 'stable' | 'ignored';

export function trendBadgeClass(trend: CheckTrend): string {
  const base = 'rounded px-1.5 py-0.5 text-xs ';
  return trend === 'degraded'
    ? `${base}bg-danger-surface text-danger-content`
    : `${base}bg-ok-surface text-ok-content`;
}
