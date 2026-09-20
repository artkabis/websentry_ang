import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './network-probe.js';
import type { BilledResult, BilledText, ProbeEngine } from './probe-engine.js';
import { RemoteProbeEngine, serveProbeRequests } from './probe-rpc.js';

function ok(url: string): ProbeResult {
  return {
    url,
    status: 200,
    ok: true,
    redirected: false,
    finalUrl: url,
    contentLength: 42,
    contentType: 'text/html',
  };
}

/** Moteur du processus principal, simulé — seul le transport est à l'épreuve. */
function engineOf(over: Partial<ProbeEngine> = {}): ProbeEngine {
  return {
    resolve: vi.fn((url: string): Promise<BilledResult> =>
      Promise.resolve({ result: ok(url), billable: true }),
    ),
    text: vi.fn((url: string): Promise<BilledText> =>
      Promise.resolve({ result: ok(url), billable: true, body: 'corps' }),
    ),
    ...over,
  };
}

/** Paire de canaux branchée : le serveur d'un côté, le moteur distant de l'autre. */
function wire(engine: ProbeEngine) {
  const channel = new MessageChannel();
  serveProbeRequests(channel.port1, engine);
  return {
    remote: new RemoteProbeEngine(channel.port2),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('sortie réseau d’un thread', () => {
  it('fait exécuter la requête par le processus principal', async () => {
    const engine = engineOf();
    const { remote, close } = wire(engine);

    const { result, billable } = await remote.resolve('https://exemple.fr/a');
    close();

    expect(engine.resolve).toHaveBeenCalledWith('https://exemple.fr/a');
    expect(result).toMatchObject({ status: 200, contentLength: 42 });
    expect(billable).toBe(true);
  });

  it('rapporte qu’une réponse n’a RIEN coûté', async () => {
    // C'est ce qui permet au quota du critère d'être remboursé : sans cette
    // information, un lien servi par le cache amputerait quand même le quota.
    const engine = engineOf({
      resolve: vi.fn((url: string) => Promise.resolve({ result: ok(url), billable: false })),
    });
    const { remote, close } = wire(engine);

    const { billable } = await remote.resolve('https://exemple.fr/menu');
    close();

    expect(billable).toBe(false);
  });

  it('transporte un corps texte et son plafond', async () => {
    const engine = engineOf();
    const { remote, close } = wire(engine);

    const { body } = await remote.text('https://exemple.fr/robots.txt', 2048);
    close();

    expect(engine.text).toHaveBeenCalledWith('https://exemple.fr/robots.txt', 2048);
    expect(body).toBe('corps');
  });

  it('ne MÉLANGE PAS les réponses de demandes simultanées', async () => {
    // Les réponses reviennent dans l'ordre où elles se terminent, pas dans
    // celui des demandes : attribuer le statut d'une URL à une autre serait
    // pire qu'une absence de résultat.
    const engine = engineOf({
      resolve: vi.fn(
        (url: string) =>
          new Promise<BilledResult>(resolve =>
            setTimeout(
              () =>
                resolve({
                  result: { ...ok(url), status: url.endsWith('b') ? 404 : 200 },
                  billable: true,
                }),
              url.endsWith('a') ? 20 : 1,
            ),
          ),
      ),
    });
    const { remote, close } = wire(engine);

    const [first, second] = await Promise.all([
      remote.resolve('https://exemple.fr/a'),
      remote.resolve('https://exemple.fr/b'),
    ]);
    close();

    expect(first?.result.status).toBe(200);
    expect(second?.result.status).toBe(404);
  });

  it('DÉNOUE les demandes en attente quand le canal se ferme', async () => {
    // Sans cela, un thread arrêté en pleine requête laisserait l'analyse
    // suspendue pour toujours.
    const channel = new MessageChannel();
    serveProbeRequests(channel.port1, engineOf({ resolve: () => new Promise(() => undefined) }));
    const remote = new RemoteProbeEngine(channel.port2);

    const pending = remote.resolve('https://exemple.fr/sans-reponse');
    channel.port2.close();

    const { result, billable } = await pending;
    expect(result.error).toBe('Sortie réseau indisponible');
    // Non facturé : le quota du critère n'a pas à payer un incident de canal.
    expect(billable).toBe(false);
    expect(result.exhausted).toBeUndefined();
  });

  it('répond sans attendre une fois le canal fermé', async () => {
    const channel = new MessageChannel();
    const engine = engineOf();
    serveProbeRequests(channel.port1, engine);
    const remote = new RemoteProbeEngine(channel.port2);
    channel.port2.close();

    const { result } = await remote.resolve('https://exemple.fr/a');

    expect(result.ok).toBe(false);
    expect(engine.resolve).not.toHaveBeenCalled();
  });

  it('n’emporte pas l’analyse quand le moteur lève', async () => {
    // Le moteur ne lève pas ; si le transport, lui, défaille, le thread doit
    // recevoir une réponse plutôt que d'attendre indéfiniment.
    const { remote, close } = wire(
      engineOf({ resolve: () => Promise.reject(new Error('panne interne')) }),
    );

    const { result } = await remote.resolve('https://exemple.fr/a');
    close();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Sortie réseau indisponible');
  });

  it('rend le résultat sous l’URL demandée', async () => {
    const { remote, close } = wire(
      engineOf({
        resolve: () => Promise.resolve({ result: ok('https://autre.fr/'), billable: true }),
      }),
    );

    const { result } = await remote.resolve('https://exemple.fr/a');
    close();

    expect(result.url).toBe('https://exemple.fr/a');
  });
});
