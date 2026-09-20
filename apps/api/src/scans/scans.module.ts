import { Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { ScanRetentionService } from './scan-retention.service.js';
import { ScansController } from './scans.controller.js';
import { ScansService } from './scans.service.js';

/** Intervalle du travail de fond — une fois par jour, comme en v1. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Module 3 — historique des scans.
 *
 * Le module expose la lecture et la suppression de l'historique, et porte le
 * travail de fond de rétention. L'ÉCRITURE de l'historique n'a délibérément
 * aucun contrôleur : `ScansService.record()` est appelée en process par le
 * module d'analyse. Un endpoint d'ingestion offrirait à un jeton volé le moyen
 * de fabriquer un passé — des audits qui n'ont jamais eu lieu, dans une base
 * dont l'objet même est de faire foi.
 */
@Module({
  controllers: [ScansController],
  providers: [ScansService, ScanRetentionService],
  exports: [ScansService],
})
export class ScansModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScansModule.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly retention: ScanRetentionService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Lance la rétention au démarrage, puis chaque jour.
   *
   * Un premier passage au démarrage rattrape ce qu'un arrêt prolongé a laissé
   * s'accumuler. `unref()` détache le minuteur de la boucle d'événements : sans
   * lui, le processus refuserait de s'arrêter pendant les heures séparant deux
   * passages — un conteneur qui ne répond plus à SIGTERM finit tué de force.
   */
  onApplicationBootstrap(): void {
    if (!this.config.retention.enabled) {
      this.logger.log('Rétention désactivée (SCAN_RETENTION_ENABLED=false)');
      return;
    }

    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), RETENTION_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Un échec de rétention ne doit jamais faire tomber l'API : le service rendu
   * ne dépend pas de la compression des rapports d'il y a six mois.
   */
  private async runSafely(): Promise<void> {
    try {
      await this.retention.run();
    } catch (err) {
      this.logger.error(`Passage de rétention en échec : ${(err as Error).message}`);
    }
  }
}
