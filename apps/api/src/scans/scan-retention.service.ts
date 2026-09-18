import { Injectable, Logger } from '@nestjs/common';
import type { RetentionResult } from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import { ScanRetentionRepository } from '../database/repositories/scan-retention.repository.js';
import { compressReport } from './scans.service.js';

/**
 * Rétention des rapports — le travail de fond.
 *
 * Trois étages de stockage, et la bascule d'un étage au suivant :
 *
 *   récent   rapport en clair          lecture immédiate
 *   ancien   rapport compressé         7 à 10 fois plus compact
 *   archivé  résumé des critères seul  le rapport a été purgé, le résumé reste
 *
 * Le dernier étage n'est pas une perte sèche : `check_summary` survit, donc la
 * comparaison entre deux scans anciens reste possible longtemps après que leur
 * détail a disparu.
 */
@Injectable()
export class ScanRetentionService {
  private readonly logger = new Logger(ScanRetentionService.name);
  private running = false;

  constructor(
    private readonly repo: ScanRetentionRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Exécute un passage complet : compression puis purge.
   *
   * Le garde `running` n'est pas une précaution abstraite. Le travail est
   * déclenché au démarrage PUIS à intervalle : sur une base volumineuse, un
   * passage peut déborder sur l'heure du suivant, et deux passages simultanés
   * compresseraient les mêmes lignes en double.
   */
  async run(): Promise<RetentionResult> {
    const started = Date.now();
    const empty: RetentionResult = { compressed: 0, purged: 0, remaining: 0, durationMs: 0 };

    if (!this.repo.available || this.running) return empty;
    const policy = this.config.retention;
    if (!policy.enabled) return empty;

    this.running = true;
    try {
      const compressed = await this.compressBatch(policy.compressAfterDays, policy.batchSize);
      const purged = await this.repo.purge(policy.purgeAfterDays, policy.batchSize);

      const pending = await this.repo.countPending(policy.compressAfterDays, policy.purgeAfterDays);
      const remaining = pending.compressible + pending.purgeable;

      const result: RetentionResult = {
        compressed,
        purged,
        remaining,
        durationMs: Date.now() - started,
      };

      if (compressed > 0 || purged > 0) {
        this.logger.log(
          `Rétention : ${compressed} rapport(s) compressé(s), ${purged} purgé(s) ` +
            `en ${result.durationMs} ms`,
        );
      }

      // La v1 s'arrêtait à sa borne sans jamais dire qu'elle prenait du retard :
      // une file grandissant plus vite qu'elle ne se vide reste invisible
      // jusqu'au jour où le disque est plein.
      if (remaining > 0) {
        this.logger.warn(
          `Rétention : ${remaining} ligne(s) encore en attente après ce passage — ` +
            'augmenter SCAN_RETENTION_BATCH ou la fréquence du travail de fond',
        );
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Compresse un lot de rapports.
   *
   * La compression est faite en JS, ligne à ligne — MariaDB ne sait pas le faire
   * — mais l'ÉCRITURE est groupée : un seul `UPDATE ... CASE` par lot. Une ligne
   * qui résiste est laissée en clair et reprise au passage suivant, plutôt que
   * de faire échouer le lot entier pour un rapport corrompu.
   */
  private async compressBatch(afterDays: number, batchSize: number): Promise<number> {
    const rows = await this.repo.findCompressible(afterDays, batchSize);
    if (rows.length === 0) return 0;

    const updates: Array<{ id: string; gz: Buffer }> = [];
    for (const row of rows) {
      try {
        updates.push({ id: row.id, gz: await compressReport(row.report) });
      } catch (err) {
        this.logger.warn(
          `Compression impossible pour la page ${row.id} : ${(err as Error).message}`,
        );
      }
    }

    return this.repo.compress(updates);
  }
}
