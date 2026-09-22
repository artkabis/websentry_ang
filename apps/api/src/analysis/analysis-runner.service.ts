import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Piscina } from 'piscina';
import type { AnalysisReport, CheckResult } from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import { SsrfService } from '../security/ssrf.service.js';
import type { EffectiveSettings } from './effective-settings.js';
import { AnalysisProbe } from './network-probe.js';
import { SsrfProbeEngine } from './probe-engine.js';
import { serveProbeRequests } from './probe-rpc.js';
import { rehydratePage } from './page-fetcher.service.js';
import { runAnalysis, type ProgressCallback } from './orchestrator.js';
import type { SerializablePage } from './page.model.js';
import type { AnalysisTask } from './analysis.worker.js';

/**
 * Exécution des analyses — pool de threads, avec repli en ligne.
 *
 * Le parse du DOM est du CPU pur : le laisser sur le thread principal fige
 * l'API pendant qu'elle analyse. Piscina l'isole dans un pool dimensionné sur
 * les cœurs disponibles, moins un — le thread principal doit continuer à servir
 * les requêtes pendant que le pool travaille.
 *
 * Le repli EN LIGNE n'est pas une commodité de test : si le pool ne démarre pas
 * (hébergement mutualisé sans `worker_threads`, mémoire contrainte), l'analyse
 * doit rester possible, plus lentement, plutôt que de devenir indisponible.
 */
@Injectable()
export class AnalysisRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalysisRunnerService.name);
  private pool: Piscina<AnalysisTask, AnalysisReport> | null = null;
  private poolFailed = false;
  private engine: SsrfProbeEngine | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly ssrf: SsrfService,
  ) {}

  /**
   * Moteur de sortie réseau — UN seul pour tout le processus.
   *
   * C'est ce qui fait qu'un lien de navigation, présent sur chaque page d'un
   * site, n'est vérifié qu'une fois pour tout un scan : un moteur par thread
   * rendrait le cache aussi fragmenté que le pool.
   */
  private probeEngine(): SsrfProbeEngine {
    this.engine ??= new SsrfProbeEngine(this.ssrf, { timeoutMs: this.config.fetchTimeoutMs });
    return this.engine;
  }

  /**
   * Canal de sortie réseau d'une tâche.
   *
   * Le thread ne sort pas lui-même : il demande, le processus principal
   * exécute, et tous les threads profitent donc du même cache.
   */
  private openProbeChannel(): MessageChannel {
    const channel = new MessageChannel();
    serveProbeRequests(channel.port1, this.probeEngine());
    return channel;
  }

  /** Analyse une page, dans le pool si disponible. */
  async run(
    page: SerializablePage,
    settings: EffectiveSettings,
    analyzeId: string,
  ): Promise<AnalysisReport> {
    const pool = this.acquirePool();
    if (!pool) return this.runInline(page, settings, analyzeId);

    const probe = this.openProbeChannel();
    try {
      const task: AnalysisTask = { page, settings, analyzeId, probePort: probe.port2 };
      return await pool.run(task, { transferList: [probe.port2] });
    } catch (err) {
      // Une défaillance du pool ne doit pas se voir comme une analyse
      // impossible : on retombe en ligne et on trace, une fois.
      this.reportPoolFailure(err);
      return this.runInline(page, settings, analyzeId);
    } finally {
      probe.port1.close();
    }
  }

  /**
   * Analyse une page en remontant la progression critère par critère.
   *
   * La progression traverse un `MessageChannel` transféré au worker. Sans lui,
   * il faudrait attendre le rapport complet pour afficher quoi que ce soit —
   * ce qui, sur une page lente, revient à ne rien afficher du tout.
   */
  async runWithProgress(
    page: SerializablePage,
    settings: EffectiveSettings,
    analyzeId: string,
    onProgress: ProgressCallback,
  ): Promise<AnalysisReport> {
    const pool = this.acquirePool();
    if (!pool) return this.runInline(page, settings, analyzeId, onProgress);

    const channel = new MessageChannel();
    channel.port1.on(
      'message',
      (message: { result: CheckResult; completed: number; total: number }) => {
        onProgress(message.result, message.completed, message.total);
      },
    );

    const probe = this.openProbeChannel();
    try {
      const task: AnalysisTask = {
        page,
        settings,
        analyzeId,
        progressPort: channel.port2,
        probePort: probe.port2,
      };
      return await pool.run(task, { transferList: [channel.port2, probe.port2] });
    } catch (err) {
      this.reportPoolFailure(err);
      return this.runInline(page, settings, analyzeId, onProgress);
    } finally {
      channel.port1.close();
      probe.port1.close();
    }
  }

  /** Analyse sur le thread courant — repli, et chemin des tests unitaires. */
  private runInline(
    page: SerializablePage,
    settings: EffectiveSettings,
    analyzeId: string,
    onProgress?: ProgressCallback,
  ): Promise<AnalysisReport> {
    return runAnalysis(rehydratePage(page), settings, {
      analyzeId,
      onProgress,
      // Même moteur que pour les threads : le cache et le portail de
      // concurrence sont partagés, quel que soit le chemin d'exécution.
      net: new AnalysisProbe(this.probeEngine()),
    });
  }

  /**
   * État du pool, pour la supervision.
   *
   * Cette méthode ne DÉMARRE rien : le pool est paresseux, et l'interroger ne
   * doit pas provoquer ce qu'il observe. Un pool « non démarré » est donc
   * normal sur une instance qui n'a encore rien analysé.
   */
  etat(): { active: boolean; demarre: boolean; enEchec: boolean; threadsMax: number } {
    const active = this.config.analysis.workersEnabled;
    return {
      active,
      demarre: this.pool !== null,
      enEchec: this.poolFailed,
      threadsMax: active ? this.maxThreads() : 0,
    };
  }

  /**
   * Pool paresseux : il n'est créé qu'à la première analyse.
   *
   * Démarrer des threads au boot coûterait de la mémoire à une instance qui,
   * bien souvent, ne sert que des lectures d'historique.
   */
  private acquirePool(): Piscina<AnalysisTask, AnalysisReport> | null {
    if (this.poolFailed || !this.config.analysis.workersEnabled) return null;
    if (this.pool) return this.pool;

    // Le worker est du JavaScript COMPILÉ : un thread Piscina est un vrai
    // thread Node, sans la transformation TypeScript de l'outillage de
    // développement. Le fichier n'existe donc qu'après `pnpm build` — en
    // développement et sous les tests, l'analyse se fait en ligne. Vérifier son
    // existence AVANT de créer le pool transforme un échec par page en une
    // décision prise une fois, et dite clairement.
    const filename = this.workerPath();
    if (!existsSync(filename)) {
      this.poolFailed = true;
      this.logger.warn(
        'Worker d’analyse non compilé — analyses exécutées en ligne. ' +
          'Normal en développement ; en production, lancer `pnpm build`.',
      );
      return null;
    }

    try {
      this.pool = new Piscina<AnalysisTask, AnalysisReport>({
        filename,
        maxThreads: this.maxThreads(),
        // Un thread qui n'a rien fait depuis une minute libère sa mémoire.
        idleTimeout: 60_000,
      });
      this.logger.log(`Pool d'analyse démarré — ${this.maxThreads()} thread(s)`);
      return this.pool;
    } catch (err) {
      this.reportPoolFailure(err);
      return null;
    }
  }

  /** Chemin du worker compilé, voisin de ce module une fois bâti. */
  private workerPath(): string {
    return fileURLToPath(new URL('./analysis.worker.js', import.meta.url));
  }

  /**
   * Un thread de moins que de cœurs, au minimum un.
   *
   * Occuper tous les cœurs ferait attendre le thread principal pour servir la
   * moindre requête pendant qu'un lot tourne.
   */
  private maxThreads(): number {
    const configured = this.config.analysis.maxWorkers;
    if (configured > 0) return configured;
    return Math.max(1, availableParallelism() - 1);
  }

  private reportPoolFailure(err: unknown): void {
    if (this.poolFailed) return;
    this.poolFailed = true;
    this.logger.error(
      `Pool d'analyse indisponible, repli en ligne : ${err instanceof Error ? err.message : 'cause inconnue'}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.pool) return;
    await this.pool.destroy();
    this.pool = null;
  }
}
