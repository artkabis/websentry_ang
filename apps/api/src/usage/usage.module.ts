import { Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { AuditAnonymizationService } from './audit-anonymization.service.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/** Intervalle du travail de fond — une fois par jour, comme la rétention. */
const ANONYMISATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Module 9 — analytics d'usage et gouvernance des données.
 *
 * Le module ne collecte rien : il agrège ce que l'application enregistre déjà.
 * Il porte en revanche le seul travail capable de MODIFIER le journal d'audit
 * — l'anonymisation passé le délai de conservation — et ce travail n'a aucun
 * déclencheur HTTP.
 */
@Module({
  controllers: [UsageController],
  providers: [UsageService, AuditAnonymizationService],
  exports: [AuditAnonymizationService],
})
export class UsageModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UsageModule.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly anonymisation: AuditAnonymizationService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Lance l'anonymisation au démarrage, puis chaque jour.
   *
   * Un premier passage au démarrage rattrape ce qu'un arrêt prolongé a laissé
   * s'accumuler — et pour une obligation de conservation limitée, ce retard
   * n'est pas qu'un détail d'exploitation. `unref()` détache le minuteur de la
   * boucle d'événements : sans lui, le processus refuserait de s'arrêter
   * pendant les heures séparant deux passages.
   */
  onApplicationBootstrap(): void {
    if (!this.config.anonymisation.enabled) {
      this.logger.warn('Anonymisation du journal DÉSACTIVÉE (AUDIT_ANONYMIZE_ENABLED=false)');
      return;
    }

    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), ANONYMISATION_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Un échec d'anonymisation ne doit jamais faire tomber l'API : le service
   * rendu ne dépend pas du traitement de lignes vieilles de six mois. Le
   * passage manqué est visible dans la gouvernance, qui compte ce qui reste.
   */
  private async runSafely(): Promise<void> {
    try {
      await this.anonymisation.run();
    } catch (err) {
      this.logger.error(`Passage d'anonymisation en échec : ${(err as Error).message}`);
    }
  }
}
