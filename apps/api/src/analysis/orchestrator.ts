import { randomUUID } from 'node:crypto';
import {
  SUB_CHECKS_REGISTRY,
  pickReportedHeaders,
  weightedGlobalScore,
  type AnalysisReport,
  type CheckItem,
  type CheckResult,
} from '@websentry/shared';
import type { BaseAnalyzer } from './base.analyzer.js';
import { createAnalyzers } from './analyzers/index.js';
import { dudaParametersOf } from './duda-parameters.js';
import type { EffectiveSettings } from './effective-settings.js';
import type { NetworkProbe } from './network-probe.js';
import type { HtmlPage } from './page.model.js';
import { applyPageRules } from './page-rules.js';

/** Libellé de remplacement quand la polarité d'un sous-critère est inversée. */
const ABSENT_LABELS = new Map(
  SUB_CHECKS_REGISTRY.filter(sub => sub.absentLabel).map(sub => [sub.key, sub.absentLabel]),
);

/** Rappel de progression — un critère terminé. */
export type ProgressCallback = (result: CheckResult, completed: number, total: number) => void;

/**
 * Exécute tous les analyseurs sur une page et assemble le rapport.
 *
 * Les analyseurs tournent en parallèle et leurs échecs sont ISOLÉS : un
 * analyseur qui lève une exception produit un critère en échec, il n'emporte
 * pas les vingt-huit autres. Un rapport partiel reste exploitable ; une absence
 * de rapport ne l'est pas.
 */
export async function runAnalysis(
  page: HtmlPage,
  settings: EffectiveSettings,
  options: { analyzeId?: string; onProgress?: ProgressCallback; net?: NetworkProbe } = {},
): Promise<AnalysisReport> {
  const startedAt = Date.now();
  const analyzeId = options.analyzeId ?? randomUUID();
  const effective = applyPageRules(page.url, settings);
  const analyzers = createAnalyzers();
  const total = analyzers.length;

  let completed = 0;
  const polarity = effective.subCheckPolarity ?? {};

  const results = await Promise.all(
    analyzers.map(async analyzer => {
      // Chaque analyseur reçoit SA vue de la sonde : son quota de requêtes est
      // fixé d'avance, et ne dépend donc pas de l'ordre dans lequel les
      // analyseurs se réveillent.
      const result = await runOne(
        analyzer,
        page,
        effective,
        polarity,
        options.net?.forCheck(analyzer.id),
      );
      completed += 1;
      options.onProgress?.(result, completed, total);
      return result;
    }),
  );

  const checks: Record<string, CheckResult> = {};
  for (const result of results) checks[result.checkId] = result;

  return buildReport(page, checks, { analyzeId, startedAt, settings: effective });
}

async function runOne(
  analyzer: BaseAnalyzer,
  page: HtmlPage,
  settings: EffectiveSettings,
  polarity: Record<string, 'present' | 'absent'>,
  net: NetworkProbe | undefined,
): Promise<CheckResult> {
  try {
    return applyPolarity(await analyzer.analyze(page, settings, net), polarity);
  } catch (err) {
    return {
      checkId: analyzer.id,
      checkTitle: analyzer.title,
      globalScore: 0,
      status: 'fail',
      items: [
        {
          label: 'Erreur interne lors de l’analyse',
          status: 'fail',
          // Le message seul, jamais la trace : un rapport est consultable par
          // des comptes qui n'ont pas à connaître l'arborescence du serveur.
          detail: err instanceof Error ? err.message.slice(0, 200) : 'Erreur inconnue',
        },
      ],
      summary: 'Erreur interne lors de l’analyse de ce critère.',
      recommendations: ['Signaler l’incident au support technique.'],
    };
  }
}

/**
 * Inverse la polarité des sous-critères marqués `absent`.
 *
 * Certains critères ont un sens opposé selon la gamme : la présence d'un
 * formulaire de contact est souhaitable ici, indésirable là. Plutôt que de
 * dupliquer l'analyseur, on inverse son verdict — et le libellé avec lui, sans
 * quoi le rapport afficherait « conforme » sous un intitulé qui dit le contraire.
 */
export function applyPolarity(
  result: CheckResult,
  polarity: Record<string, 'present' | 'absent'>,
): CheckResult {
  if (result.items.length === 0 || Object.keys(polarity).length === 0) return result;

  const affected = result.items.some(item => item.key && polarity[item.key] === 'absent');
  if (!affected) return result;

  const items: CheckItem[] = result.items.map(item => {
    if (!item.key || polarity[item.key] !== 'absent') return item;
    return {
      ...item,
      status: invertStatus(item.status),
      label: ABSENT_LABELS.get(item.key) ?? `${item.label} (polarité inversée)`,
    };
  });

  const failures = items.filter(item => item.status === 'fail').length;
  const warnings = items.filter(item => item.status === 'warning').length;

  return {
    ...result,
    items,
    globalScore: polarityScore(failures, warnings),
    status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
  };
}

/**
 * Inversion d'un statut.
 *
 * `info` et `na` ne s'inversent PAS : ils ne portent aucun jugement, donc leur
 * contraire n'existe pas. Un avertissement devient `info` — l'inverse d'un
 * « attention » n'est pas un « très bien », c'est l'absence de remarque.
 */
function invertStatus(status: CheckItem['status']): CheckItem['status'] {
  if (status === 'pass') return 'fail';
  if (status === 'fail') return 'pass';
  if (status === 'warning') return 'info';
  return status;
}

function polarityScore(failures: number, warnings: number): number {
  if (failures === 0 && warnings === 0) return 5;
  if (failures === 0) return 4;
  if (failures === 1) return 3;
  return failures <= 3 ? 2 : 1;
}

function buildReport(
  page: HtmlPage,
  checks: Record<string, CheckResult>,
  context: { analyzeId: string; startedAt: number; settings: EffectiveSettings },
): AnalysisReport {
  // Moyenne PONDÉRÉE : chaque critère porte le poids de son profil, et un
  // critère en mode indicatif pèse zéro. Une moyenne simple donnerait le même
  // poids à la structure des titres qu'à la présence d'une Twitter Card.
  const globalScore = weightedGlobalScore(
    Object.values(checks).map(check => ({
      id: check.checkId,
      globalScore: check.globalScore,
      status: check.status,
    })),
    context.settings,
  );

  return {
    analyzeId: context.analyzeId,
    url: page.url,
    title: page.title,
    analyzedAt: new Date().toISOString(),
    durationMs: Date.now() - context.startedAt,
    globalScore,
    platform: page.platform,
    renderMode: 'static',
    statusCode: page.statusCode,
    ttfb: page.ttfb,
    redirectChain: page.redirectChain,
    htmlSize: Buffer.byteLength(page.html, 'utf8'),
    httpHeaders: pickReportedHeaders(page.headers),
    // `null` dit « pas un site Duda » — le cas de la majorité des pages.
    dudaParams: dudaParametersOf(page),
    checks,
  };
}
