import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { readSseStream } from './analysis.api';

/**
 * `ReadableStream` vient de Node et non de jsdom : l'environnement de test
 * simule un navigateur mais n'implémente pas les flux. Le navigateur réel, lui,
 * les fournit nativement — c'est bien la même interface qui est exercée.
 */

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

/** Construit un flux à partir de tranches d'octets arbitraires. */
function streamOf(chunks: readonly string[]): globalThis.ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }) as unknown as globalThis.ReadableStream<Uint8Array>;
}

async function collect(chunks: readonly string[], signal?: AbortSignal) {
  const events = [];
  for await (const event of readSseStream(streamOf(chunks), signal)) events.push(event);
  return events;
}

const START = `data: ${JSON.stringify({ type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 7 })}\n\n`;
const ERROR = `data: ${JSON.stringify({ type: 'error', analyzeId: null, message: 'échec' })}\n\n`;

describe('readSseStream', () => {
  it('lit un événement complet', async () => {
    const events = await collect([START]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'start', total: 7 });
  });

  it('REASSEMBLE un événement coupé en deux paquets', async () => {
    // Les événements arrivent par tranches TCP arbitraires : sans tampon, un
    // événement coupé au milieu d'un nombre serait perdu, ou pire, mal lu.
    const middle = Math.floor(START.length / 2);
    const events = await collect([START.slice(0, middle), START.slice(middle)]);
    expect(events).toHaveLength(1);
  });

  it('lit DEUX événements arrivés dans le même paquet', async () => {
    const events = await collect([START + ERROR]);
    expect(events.map(event => event.type)).toEqual(['start', 'error']);
  });

  it('IGNORE un bloc illisible sans interrompre le flux', async () => {
    // Perdre un événement de progression est sans conséquence ; perdre
    // l'analyse entière en a une.
    const events = await collect(['data: {ceci n’est pas du JSON}\n\n', START]);
    expect(events).toHaveLength(1);
  });

  it('REJETTE un événement qui ne respecte pas le contrat', async () => {
    // Un événement mal formé serait accepté comme du JSON valide et casserait
    // l'affichage sans rien dire.
    const invalid = `data: ${JSON.stringify({ type: 'start', analyzeId: 'pas-un-uuid', url: 'x', total: -1 })}\n\n`;
    expect(await collect([invalid])).toEqual([]);
  });

  it('ignore les lignes de commentaire et les champs inconnus', async () => {
    const events = await collect([`: battement\nevent: message\n${START}`]);
    expect(events).toHaveLength(1);
  });

  it('n’émet rien pour un bloc sans champ data', async () => {
    expect(await collect([': battement seul\n\n'])).toEqual([]);
  });

  it('abandonne un tampon incomplet en fin de flux', async () => {
    // Un flux coupé en route ne doit pas produire un demi-événement.
    expect(await collect(['data: {"type":"start"'])).toEqual([]);
  });

  it('S’ARRÊTE quand la lecture est annulée', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect([START], controller.signal)).toEqual([]);
  });

  it('tient sur un flux vide', async () => {
    expect(await collect([])).toEqual([]);
  });
});
