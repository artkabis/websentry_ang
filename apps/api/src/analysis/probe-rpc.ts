import type { MessagePort } from 'node:worker_threads';
import type { ProbeResult } from './network-probe.js';
import type { BilledResult, BilledText, ProbeEngine } from './probe-engine.js';

/**
 * Sortie réseau d'un thread d'analyse — servie par le processus principal.
 *
 * Un thread ne sort PAS lui-même. Il demande, le processus principal exécute.
 * La raison n'est pas la sécurité (la politique SSRF s'appliquait déjà dans le
 * thread) mais le PARTAGE : un cache par thread revérifie le menu et le pied de
 * page d'un site autant de fois qu'il y a de threads. Sur un lot de deux cents
 * pages réparties sur huit threads, c'est huit fois le même travail — et huit
 * fois la même charge infligée au site audité.
 *
 * Conséquence assumée : les requêtes sortantes reviennent sur la boucle
 * d'événements principale. C'est de l'attente réseau, pas du calcul — ce que le
 * thread isole est le parse du DOM, qui, lui, y reste.
 *
 * Aucun délai d'expiration n'est posé sur un aller-retour : une demande peut
 * légitimement patienter derrière le portail de concurrence, et un délai fixe
 * la déclarerait perdue alors qu'elle attend son tour. Ce qui dénoue une
 * attente, c'est la FERMETURE du canal — fin de tâche ou thread arrêté.
 */

type ProbeCall = { op: 'resolve'; url: string } | { op: 'text'; url: string; maxBytes: number };

type ProbeRequest = ProbeCall & { id: number };

interface ProbeReply {
  id: number;
  payload: BilledText;
}

/**
 * Branche un canal sur le moteur — côté processus principal.
 *
 * Le moteur ne lève pas ; la garde `catch` couvre une défaillance du transport
 * lui-même, qui laisserait sinon le thread attendre une réponse qui ne vient
 * jamais.
 */
export function serveProbeRequests(port: MessagePort, engine: ProbeEngine): void {
  port.on('message', (request: ProbeRequest) => {
    void (async () => {
      let payload: BilledText;
      try {
        payload =
          request.op === 'text'
            ? await engine.text(request.url, request.maxBytes)
            : { ...(await engine.resolve(request.url)), body: null };
      } catch {
        payload = { ...unavailable(request.url), body: null };
      }

      try {
        port.postMessage({ id: request.id, payload } satisfies ProbeReply);
      } catch {
        /* canal fermé entre la demande et la réponse — le thread a fini */
      }
    })();
  });
}

/** Moteur de sonde d'un thread : il délègue tout au processus principal. */
export class RemoteProbeEngine implements ProbeEngine {
  private nextId = 1;
  private readonly pending = new Map<number, (payload: BilledText) => void>();
  private closed = false;

  constructor(private readonly port: MessagePort) {
    port.on('message', (reply: ProbeReply) => {
      const settle = this.pending.get(reply.id);
      if (!settle) return;
      this.pending.delete(reply.id);
      settle(reply.payload);
    });

    // Canal fermé alors que des demandes attendent : on les dénoue plutôt que
    // de laisser l'analyse suspendue pour toujours.
    port.on('close', () => {
      this.closed = true;
      for (const [id, settle] of this.pending) {
        this.pending.delete(id);
        settle({ ...unavailable(''), body: null });
      }
    });
  }

  async resolve(url: string): Promise<BilledResult> {
    const { result, billable } = await this.ask({ op: 'resolve', url });
    return { result: withUrl(result, url), billable };
  }

  async text(url: string, maxBytes: number): Promise<BilledText> {
    const reply = await this.ask({ op: 'text', url, maxBytes });
    return { ...reply, result: withUrl(reply.result, url) };
  }

  private ask(call: ProbeCall): Promise<BilledText> {
    if (this.closed) return Promise.resolve({ ...unavailable(call.url), body: null });

    const id = this.nextId++;
    return new Promise<BilledText>(resolve => {
      this.pending.set(id, resolve);
      try {
        this.port.postMessage({ ...call, id } satisfies ProbeRequest);
      } catch {
        this.pending.delete(id);
        resolve({ ...unavailable(call.url), body: null });
      }
    });
  }
}

/**
 * Résultat d'une demande qui n'a pas pu être servie.
 *
 * Il n'est PAS marqué `exhausted` : le quota n'y est pour rien. Il n'est pas
 * facturé non plus — faire payer au critère une requête qui n'est jamais partie
 * amputerait son quota d'un incident de transport.
 */
function unavailable(url: string): BilledResult {
  return {
    billable: false,
    result: {
      url,
      status: null,
      ok: false,
      redirected: false,
      finalUrl: url,
      contentLength: null,
      contentType: null,
      error: 'Sortie réseau indisponible',
    },
  };
}

/** L'URL demandée fait foi : une réponse de secours peut ne pas la porter. */
function withUrl(result: ProbeResult, url: string): ProbeResult {
  return result.url === url ? result : { ...result, url, finalUrl: result.finalUrl || url };
}
