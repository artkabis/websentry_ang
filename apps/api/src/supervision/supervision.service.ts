import { Injectable, Logger } from '@nestjs/common';
import {
  etatGlobal,
  type BaseDeDonnees,
  type EtatComposant,
  type PoolAnalyse,
  type RetentionEtat,
  type Supervision,
  type Volumetrie,
} from '@websentry/shared';
import { AnalysisRunnerService } from '../analysis/analysis-runner.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SupervisionRepository } from '../database/repositories/supervision.repository.js';
import { ScanRetentionService } from '../scans/scan-retention.service.js';

/** Version applicative — alignée sur celle que sert la sonde publique. */
const VERSION = '2.0.0';

/**
 * Supervision.
 *
 * Règle qui gouverne tout ce fichier : **aucun composant en panne ne doit
 * faire échouer le relevé**. Une page de supervision qui rend 500 parce que la
 * base est tombée est inutile au moment précis où elle servirait. Chaque sonde
 * est donc isolée, et son échec devient une ligne du rapport.
 */
@Injectable()
export class SupervisionService {
  private readonly logger = new Logger(SupervisionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: SupervisionRepository,
    private readonly runner: AnalysisRunnerService,
    private readonly retention: ScanRetentionService,
    private readonly config: AppConfigService,
  ) {}

  async releve(): Promise<Supervision> {
    const base = await this.sonderBase();
    const poolAnalyse = this.sonderPool();
    const retention = this.sonderRetention();
    const volumetrie = base.etat === 'panne' ? null : await this.sonderVolumetrie();

    return {
      // Dérivé, jamais déclaré à part : deux sources pourraient se
      // contredire, et c'est alors le résumé qu'on croit.
      etat: etatGlobal([base.etat, poolAnalyse.etat, retention.etat]),
      releveA: new Date().toISOString(),
      instance: {
        version: VERSION,
        environnement: this.config.nodeEnv,
        uptimeSec: Math.floor(process.uptime()),
      },
      base,
      poolAnalyse,
      retention,
      volumetrie,
    };
  }

  private async sonderBase(): Promise<BaseDeDonnees> {
    const sonde = await this.db.ping();

    if (sonde.ok) {
      return {
        etat: 'ok',
        message: `Connectée, ${sonde.latenceMs} ms.`,
        active: true,
        latenceMs: sonde.latenceMs,
      };
    }

    // Une base DÉSACTIVÉE n'est pas une base en panne : c'est un choix de
    // configuration, et l'annoncer comme une panne ferait chercher un
    // incident là où il n'y en a pas.
    if (sonde.erreur === null) {
      return {
        etat: 'degrade',
        message: 'Désactivée (DB_ENABLED=false) — historique et comptes indisponibles.',
        active: false,
        latenceMs: null,
      };
    }

    return {
      etat: 'panne',
      message: 'Injoignable — les lectures et les écritures échouent.',
      active: true,
      latenceMs: null,
    };
  }

  private sonderPool(): PoolAnalyse {
    const etat = this.runner.etat();

    if (!etat.active) {
      return {
        ...etat,
        etat: 'ok',
        message: 'Threads désactivés par configuration — analyses exécutées en ligne.',
      };
    }
    if (etat.enEchec) {
      // DÉGRADÉ et non en panne : l'outil rend toujours un rapport, seulement
      // plus lentement. Le ranger en panne ferait réagir dans l'urgence pour
      // une perte de débit.
      return {
        ...etat,
        etat: 'degrade',
        message: 'Pool indisponible — analyses exécutées en ligne, donc plus lentes.',
      };
    }
    return {
      ...etat,
      etat: 'ok',
      message: etat.demarre
        ? `Pool démarré — ${etat.threadsMax} thread(s).`
        : 'Pool prêt, démarré à la première analyse.',
    };
  }

  private sonderRetention(): RetentionEtat {
    const active = this.config.retention.enabled;
    const dernierPassage = this.retention.dernierPassage();

    if (!active) {
      return {
        etat: 'degrade',
        message: 'Désactivée — les rapports s’accumulent sans être compressés ni purgés.',
        active: false,
        dernierPassage: null,
      };
    }
    if (!dernierPassage) {
      return {
        etat: 'ok',
        message: 'Aucun passage depuis le démarrage.',
        active: true,
        dernierPassage: null,
      };
    }
    if (!dernierPassage.reussi) {
      return {
        etat: 'panne',
        message: 'Dernier passage en échec — la file grandit depuis.',
        active: true,
        dernierPassage,
      };
    }
    if (dernierPassage.restants > 0) {
      // Une file qui ne se vide pas est le symptôme silencieux de la v1 :
      // elle reste invisible jusqu'au jour où le disque est plein.
      return {
        etat: 'degrade',
        message: `${dernierPassage.restants} ligne(s) encore en attente après le dernier passage.`,
        active: true,
        dernierPassage,
      };
    }
    return {
      etat: 'ok',
      message: 'Dernier passage réussi, rien en attente.',
      active: true,
      dernierPassage,
    };
  }

  /**
   * Volumétrie — les quatre comptages, ou `null`.
   *
   * L'échec est AVALÉ : la volumétrie est un agrément, pas un diagnostic, et
   * la perdre ne doit pas emporter le reste du relevé.
   */
  private async sonderVolumetrie(): Promise<Volumetrie | null> {
    if (!this.repo.available) return null;

    try {
      const [scans24h, scans7j, comptesActifs, retoursOuverts] = await Promise.all([
        this.repo.scans24h(),
        this.repo.scans7j(),
        this.repo.comptesActifs(),
        this.repo.retoursOuverts(),
      ]);
      return { scans24h, scans7j, comptesActifs, retoursOuverts };
    } catch (err) {
      this.logger.warn(`Volumétrie indisponible : ${(err as Error).message}`);
      return null;
    }
  }
}

/** Réexport pour les tests — le type d'état vit dans le paquet partagé. */
export type { EtatComposant };
