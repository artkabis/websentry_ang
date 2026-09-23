import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { UsageRepository } from '../database/repositories/usage.repository.js';

/** Trace du dernier passage, telle que la gouvernance la présente. */
export interface PassageAnonymisation {
  termineA: string;
  anonymisees: number;
  dureeMs: number;
  reussi: boolean;
}

/**
 * Anonymisation du journal d'audit — le travail de fond.
 *
 * Passé le délai de conservation, une ligne perd son identifiant, son nom et
 * son adresse IP. Elle garde son action, sa cible et son horodatage : c'est ce
 * qui fait du journal une preuve, et les effacer reviendrait à prétendre que
 * rien ne s'est passé.
 *
 * Le journal reste APPEND-ONLY au sens où il l'a toujours été : aucune route
 * HTTP n'écrit dedans, aucune ne le modifie, et `AuditRepository` n'expose
 * toujours ni UPDATE ni DELETE. Ce service passe par un autre dépôt, qu'aucun
 * contrôleur n'atteint — la seule façon de le déclencher est le minuteur.
 *
 * Le passage est BORNÉ par lot : une seule requête sur un journal volumineux
 * bloquerait la table pendant tout le traitement, et l'API avec elle.
 */
@Injectable()
export class AuditAnonymizationService {
  private readonly logger = new Logger(AuditAnonymizationService.name);
  private running = false;

  /**
   * Dernier passage observé, EN MÉMOIRE.
   *
   * Il disparaît au redémarrage, comme celui de la rétention des scans : le
   * journaliser en base demanderait une table pour une donnée qu'on ne
   * consulte qu'en direct. L'écran annonce « aucun passage depuis le
   * démarrage » plutôt que de laisser croire à une absence de travail.
   */
  private dernier: PassageAnonymisation | null = null;

  constructor(
    private readonly repo: UsageRepository,
    private readonly config: AppConfigService,
  ) {}

  dernierPassage(): PassageAnonymisation | null {
    return this.dernier;
  }

  /** Instant avant lequel une ligne doit avoir perdu son identité. */
  seuil(maintenant = new Date()): Date {
    const seuil = new Date(maintenant);
    seuil.setUTCDate(seuil.getUTCDate() - this.config.anonymisation.afterDays);
    return seuil;
  }

  /**
   * Exécute un passage.
   *
   * Le garde `running` n'est pas une précaution abstraite : le travail est
   * déclenché au démarrage PUIS à intervalle, et sur un journal volumineux un
   * passage peut déborder sur l'heure du suivant.
   */
  async run(): Promise<number> {
    if (!this.repo.available || this.running) return 0;

    const politique = this.config.anonymisation;
    if (!politique.enabled) return 0;

    this.running = true;
    const debut = Date.now();
    let anonymisees = 0;
    let reussi = true;

    try {
      const avant = this.seuil().toISOString();
      // Autant de lots que nécessaire, mais jamais une boucle infinie : on
      // s'arrête dès qu'un lot ne remplit plus la borne.
      let touchees = 0;
      do {
        touchees = await this.repo.anonymiser(avant, politique.batchSize);
        anonymisees += touchees;
      } while (touchees === politique.batchSize);

      if (anonymisees > 0) {
        this.logger.log(`Journal d'audit — ${anonymisees} ligne(s) anonymisée(s)`);
      }
      return anonymisees;
    } catch (err) {
      // L'échec est RETENU avant d'être propagé : la gouvernance doit pouvoir
      // dire qu'un passage a échoué, pas seulement qu'il n'a rien fait.
      reussi = false;
      this.logger.error(`Anonymisation en échec : ${(err as Error).message}`);
      throw err;
    } finally {
      this.dernier = {
        termineA: new Date().toISOString(),
        anonymisees,
        dureeMs: Date.now() - debut,
        reussi,
      };
      this.running = false;
    }
  }
}
