import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PROFILE,
  normalizeGamme,
  type AnalysisReport,
  type BatchItem,
  type BatchResponse,
  type SettingsOverride,
} from '@websentry/shared';
import { ProfilesService } from '../profiles/profiles.service.js';
import { ScansService } from '../scans/scans.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { AnalysisRunnerService } from './analysis-runner.service.js';
import { PageFetcherService } from './page-fetcher.service.js';
import type { EffectiveSettings } from './effective-settings.js';
import type { ProgressCallback } from './orchestrator.js';
import { extractGamme } from './duda-uid.js';
import { toCheckSummary } from './report-summary.js';

/** Qui lance l'analyse — pour l'historique et la résolution de profil. */
export interface AnalysisActor {
  username: string;
  /** `true` si l'appelant peut imposer un profil (permission `profiles:use`). */
  canChooseProfile: boolean;
}

export interface AnalyzeOptions {
  settingsOverride?: SettingsOverride;
  profileOverride?: string;
  /**
   * Identifiant imposé par l'appelant.
   *
   * Le flux SSE en a besoin AVANT que l'analyse commence : ses événements le
   * portent tous, y compris celui émis quand la page ne répond pas — donc
   * avant qu'un rapport existe pour le fournir.
   */
  analyzeId?: string;
}

/**
 * Moteur d'analyse — orchestration de bout en bout.
 *
 * Il enchaîne : récupération SSRF-sûre de la page, résolution du profil,
 * exécution des analyseurs dans un thread, puis enregistrement dans
 * l'historique. Chacune de ces étapes appartient à un module déjà livré ; ce
 * service est ce qui les relie, et rien d'autre.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly fetcher: PageFetcherService,
    private readonly runner: AnalysisRunnerService,
    private readonly profiles: ProfilesService,
    private readonly scans: ScansService,
    private readonly config: AppConfigService,
  ) {}

  /** Analyse une page et enregistre le résultat. */
  async analyzePage(
    url: string,
    actor: AnalysisActor,
    options: AnalyzeOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<AnalysisReport> {
    const analyzeId = options.analyzeId ?? randomUUID();
    const page = await this.fetcher.fetchPage(url);
    const { settings, gamme } = await this.resolveSettings(page.html, actor, options);

    const report = onProgress
      ? await this.runner.runWithProgress(page, settings, analyzeId, onProgress)
      : await this.runner.run(page, settings, analyzeId);

    await this.record([report], gamme, actor);
    return report;
  }

  /**
   * Analyse un lot d'URL.
   *
   * La concurrence est BORNÉE : lancer deux cents analyses de front saturerait
   * la sortie réseau et déclencherait la limitation de débit des sites
   * analysés — qui répondraient alors 429, et le rapport conclurait à tort que
   * le site est en panne.
   */
  async analyzeBatch(
    urls: readonly string[],
    actor: AnalysisActor,
    options: AnalyzeOptions = {},
    onPage?: (item: BatchItem, completed: number, total: number) => void,
  ): Promise<BatchResponse> {
    const batchId = randomUUID();
    const startedAt = Date.now();
    const results: BatchItem[] = [];
    const reports: AnalysisReport[] = [];
    let gamme: string | null = null;
    let completed = 0;

    const queue = [...urls];
    const workers = Array.from(
      { length: Math.min(this.config.analysis.batchConcurrency, queue.length) },
      async () => {
        for (;;) {
          const url = queue.shift();
          if (url === undefined) return;

          const item = await this.analyzeOne(url, actor, options);
          if (item.report) {
            reports.push(item.report);
            gamme ??= item.gamme;
          }
          results.push(item.entry);
          completed += 1;
          onPage?.(item.entry, completed, urls.length);
        }
      },
    );

    await Promise.all(workers);
    if (reports.length > 0) await this.record(reports, gamme, actor);

    const succeeded = results.filter(item => item.ok).length;
    return {
      batchId,
      total: urls.length,
      succeeded,
      failed: results.length - succeeded,
      durationMs: Date.now() - startedAt,
      // L'ordre d'arrivée dépend de la concurrence : on rétablit celui demandé,
      // sans quoi deux lancements identiques rendraient deux rapports
      // différemment ordonnés.
      results: orderByRequest(results, urls),
    };
  }

  /**
   * Analyse une URL sans jamais lever.
   *
   * L'échec d'une page ne fait pas échouer le lot : analyser cinquante pages et
   * tout perdre parce que la douzième renvoie un 500 serait absurde.
   */
  private async analyzeOne(
    url: string,
    actor: AnalysisActor,
    options: AnalyzeOptions,
  ): Promise<{ entry: BatchItem; report: AnalysisReport | null; gamme: string | null }> {
    try {
      const page = await this.fetcher.fetchPage(url);
      const { settings, gamme } = await this.resolveSettings(page.html, actor, options);
      const report = await this.runner.run(page, settings, randomUUID());
      return { entry: { url, ok: true, report, error: null }, report, gamme };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analyse impossible';
      this.logger.warn(`Analyse en échec pour ${url} : ${message}`);
      return {
        entry: { url, ok: false, report: null, error: message.slice(0, 500) },
        report: null,
        gamme: null,
      };
    }
  }

  /**
   * Résout les réglages applicables à une page.
   *
   * Trois sources, par priorité croissante : le profil de la gamme DÉTECTÉE
   * dans la page, le profil CHOISI par l'appelant s'il en a le droit, puis ses
   * surcharges ponctuelles. Un profil choisi sans la permission est ignoré —
   * jamais refusé : l'utilisateur obtient son analyse, avec le profil auquel il
   * a droit.
   */
  private async resolveSettings(
    html: string,
    actor: AnalysisActor,
    options: AnalyzeOptions,
  ): Promise<{ settings: EffectiveSettings; gamme: string | null }> {
    const detected = extractGamme(html);
    const chosen =
      actor.canChooseProfile && options.profileOverride
        ? normalizeGamme(options.profileOverride)
        : null;

    const requested = chosen ?? detected ?? DEFAULT_PROFILE;
    const { settings: base } = await this.profiles.resolveSettings(requested);

    return {
      settings: options.settingsOverride ? { ...base, ...options.settingsOverride } : base,
      // La gamme conservée dans l'historique est celle DÉTECTÉE dans la page,
      // jamais celle choisie par l'appelant : l'historique décrit le site tel
      // qu'il est, pas le profil avec lequel on a voulu le lire.
      gamme: detected,
    };
  }

  /**
   * Enregistre une session dans l'historique.
   *
   * L'écriture est appelée EN PROCESS, jamais exposée en HTTP (cf. module 3).
   * Son échec n'interrompt pas l'analyse : perdre la trace d'un scan dégrade la
   * traçabilité, pas le service rendu.
   */
  private async record(
    reports: readonly AnalysisReport[],
    gamme: string | null,
    actor: AnalysisActor,
  ): Promise<void> {
    const first = reports[0];
    if (!first) return;

    try {
      await this.scans.record({
        sessionId: randomUUID(),
        domain: hostnameOf(first.url),
        gamme,
        epj: null,
        platform: first.platform,
        siteAlias: null,
        metadata: null,
        launchedBy: actor.username,
        durationMs: reports.reduce((sum, report) => sum + report.durationMs, 0),
        profileSnapshot: null,
        pages: reports.map(report => ({
          url: report.url,
          globalScore: report.globalScore,
          statusCode: report.statusCode,
          analyzedAt: report.analyzedAt,
          durationMs: report.durationMs,
          checkSummary: toCheckSummary(report.checks),
          report,
        })),
      });
    } catch (err) {
      this.logger.error(
        `Historisation impossible : ${err instanceof Error ? err.message : 'cause inconnue'}`,
      );
    }
  }
}

/** Hostname d'une URL, ou l'URL tronquée si elle est illisible. */
export function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl.slice(0, 255);
  }
}

/**
 * Rétablit l'ordre demandé par l'appelant.
 *
 * Les résultats arrivent dans l'ordre d'achèvement, qui dépend de la latence de
 * chaque site : sans remise en ordre, deux lancements identiques rendraient
 * deux rapports différemment ordonnés, et toute comparaison deviendrait
 * illisible.
 */
export function orderByRequest(
  results: readonly BatchItem[],
  urls: readonly string[],
): BatchItem[] {
  const byUrl = new Map(results.map(item => [item.url, item]));
  const ordered: BatchItem[] = [];
  for (const url of urls) {
    const item = byUrl.get(url);
    if (item) {
      ordered.push(item);
      byUrl.delete(url);
    }
  }
  return ordered;
}
