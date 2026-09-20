import type { MessagePort } from 'node:worker_threads';
import type { AnalysisReport } from '@websentry/shared';
import type { EffectiveSettings } from './effective-settings.js';
import { AnalysisProbe } from './network-probe.js';
import { RemoteProbeEngine } from './probe-rpc.js';
import { rehydratePage } from './page-fetcher.service.js';
import { runAnalysis } from './orchestrator.js';
import type { SerializablePage } from './page.model.js';

/**
 * Tâche exécutée dans un thread Piscina.
 *
 * Tout ce qui entre et sort d'ici est SÉRIALISABLE : pas d'instance Cheerio en
 * entrée, pas d'injection Nest, pas de connexion à la base. Le thread ne sait
 * rien de l'application — c'est précisément ce qui permet de le remplacer, de
 * le tuer ou de le multiplier sans conséquence.
 *
 * Le travail sorti de la boucle d'événements est le parse du DOM : sur une page
 * de plusieurs centaines de kilo-octets, il bloque le thread principal assez
 * longtemps pour retarder toutes les autres requêtes servies.
 */
export interface AnalysisTask {
  page: SerializablePage;
  settings: EffectiveSettings;
  analyzeId: string;
  /**
   * Canal de progression, transmis via `transferList`.
   *
   * Présent uniquement pour le flux SSE : sans lui, la progression ne remonte
   * pas et l'utilisateur regarde un écran figé pendant toute l'analyse.
   */
  progressPort?: MessagePort;
  /**
   * Canal de sortie réseau, transmis via `transferList`.
   *
   * Le thread ne sort pas lui-même : il demande au processus principal, qui
   * applique la politique SSRF et sert un cache COMMUN à tous les threads. Un
   * moteur par thread revérifierait le menu et le pied de page d'un site
   * autant de fois qu'il y a de threads.
   */
  probePort?: MessagePort;
}

export default async function analyzeInWorker(task: AnalysisTask): Promise<AnalysisReport> {
  const page = rehydratePage(task.page);
  const port = task.progressPort;
  const probePort = task.probePort;

  try {
    return await runAnalysis(page, task.settings, {
      analyzeId: task.analyzeId,
      net: probePort ? new AnalysisProbe(new RemoteProbeEngine(probePort)) : undefined,
      onProgress: port
        ? (result, completed, total) => {
            // `postMessage` peut échouer si le client s'est déconnecté et que le
            // port a été fermé : la progression n'est pas la raison d'être de
            // l'analyse, elle ne doit pas la faire échouer.
            try {
              port.postMessage({ result, completed, total });
            } catch {
              /* canal fermé — on continue l'analyse */
            }
          }
        : undefined,
    });
  } finally {
    port?.close();
    probePort?.close();
  }
}
