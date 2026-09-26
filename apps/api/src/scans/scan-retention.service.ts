import { Injectable, Logger } from '@nestjs/common';
import type { RetentionResult } from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import { ScanRetentionRepository } from '../database/repositories/scan-retention.repository.js';
import { ScanTrashService } from './scan-trash.service.js';
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
/** Trace du dernier passage, telle que la supervision la présente. */
export interface DernierPassage {
  termineA: string;
  compresses: number;
  purges: number;
  restants: number;
  dureeMs: number;
  reussi: boolean;
}

@Injectable()
export class ScanRetentionService {
  private readonly logger = new Logger(ScanRetentionService.name);
  private running = false;

  /**
   * Dernier passage observé, EN MÉMOIRE.
   *
   * Il disparaît au redémarrage, et c'est assumé : le journaliser en base
   * demanderait une table pour une donnée qu'on ne consulte qu'en direct, et
   * qui perd tout intérêt une fois le processus reparti — après un
   * redémarrage, le prochain passage dira la vérité mieux que l'ancien.
   * L'écran annonce « aucun passage depuis le démarrage » plutôt que de
   * laisser croire à une absence de travail.
   */
  private dernier: DernierPassage | null = null;

  constructor(
    private readonly repo: ScanRetentionRepository,
    private readonly config: AppConfigService,
    private readonly corbeille: ScanTrashService,
  ) {}

  /**
   * Exécute un passage complet : compression puis purge.
   *
   * Le garde `running` n'est pas une précaution abstraite. Le travail est
   * déclenché au démarrage PUIS à intervalle : sur une base volumineuse, un
   * passage peut déborder sur l'heure du suivant, et deux passages simultanés
   * compresseraient les mêmes lignes en double.
   */
  /** Dernier passage observé depuis le démarrage — `null` si aucun encore. */
  dernierPassage(): DernierPassage | null {
    return this.dernier;
  }

  async run(): Promise<RetentionResult> {
    const started = Date.now();
    const empty: RetentionResult = {
      compressed: 0,
      purged: 0,
      trashPurged: 0,
      remaining: 0,
      durationMs: 0,
    };

    if (!this.repo.available || this.running) return empty;
    const policy = this.config.retention;
    if (!policy.enabled) return empty;

    this.running = true;
    try {
      const compressed = await this.compressBatch(policy.compressAfterDays, policy.batchSize);
      const purged = await this.repo.purge(policy.purgeAfterDays, policy.batchSize);
      // La corbeille est vidée par le MÊME passage : un second travail de fond
      // pour une seule requête ajouterait un minuteur à surveiller et une
      // occasion de plus qu'il ne tourne pas.
      const trashPurged = await this.corbeille.purgerEchues();

      const pending = await this.repo.countPending(policy.compressAfterDays, policy.purgeAfterDays);
      const remaining = pending.compressible + pending.purgeable;

      const result: RetentionResult = {
        compressed,
        purged,
        trashPurged,
        remaining,
        durationMs: Date.now() - started,
      };

      if (compressed > 0 || purged > 0 || trashPurged > 0) {
        this.logger.log(
          `Rétention : ${compressed} rapport(s) compressé(s), ${purged} purgé(s), ` +
            `${trashPurged} entrée(s) de corbeille effacée(s) en ${result.durationMs} ms`,
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

      this.dernier = { ...versPassage(result), reussi: true };
      return result;
    } catch (err) {
      // L'échec est RETENU avant d'être relancé : sans cela, la supervision
      // afficherait le dernier passage réussi et laisserait croire que tout
      // va bien, alors que la file grandit depuis.
      this.dernier = {
        termineA: new Date().toISOString(),
        compresses: 0,
        purges: 0,
        restants: 0,
        dureeMs: Date.now() - started,
        reussi: false,
      };
      throw err;
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

/** Résultat d'un passage → trace horodatée. */
function versPassage(resultat: RetentionResult): Omit<DernierPassage, 'reussi'> {
  return {
    termineA: new Date().toISOString(),
    compresses: resultat.compressed,
    purges: resultat.purged,
    restants: resultat.remaining,
    dureeMs: resultat.durationMs,
  };
}
