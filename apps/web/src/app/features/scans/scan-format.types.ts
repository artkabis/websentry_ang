import type { CheckStatus, ReportState } from '@websentry/shared';

export type { CheckStatus, ReportState };

/** Classe qualitative d'un score — quatre cas, `unknown` compris. */
export type ScoreClass = 'good' | 'warning' | 'critical' | 'unknown';
