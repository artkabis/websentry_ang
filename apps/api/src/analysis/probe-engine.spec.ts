import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SsrfBlockedError,
  type SafeFetchResult,
  type SsrfService,
} from '../security/ssrf.service.js';
import { SsrfProbeEngine, clearProbeCache } from './probe-engine.js';

/** Réponse minimale — seuls le statut et les en-têtes intéressent le moteur. */
function reply(status: number, headers: Record<string, string> = {}): SafeFetchResult {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    },
    finalUrl: 'https://exemple.fr/cible',
    redirectChain: [],
    redirected: false,
    dispose: () => undefined,
  } as unknown as SafeFetchResult;
}

type Ssrf = Pick<SsrfService, 'safeFetch' | 'readTextCapped'>;

function makeSsrf(impl: Ssrf['safeFetch'], text = '') {
  return {
    safeFetch: vi.fn(impl),
    readTextCapped: vi.fn<Ssrf['readTextCapped']>().mockResolvedValue(text),
  };
}

/** Réponse différée, pour observer ce qui se passe pendant la requête. */
function slow(status: number, ms: number): Promise<SafeFetchResult> {
  return new Promise(resolve => setTimeout(() => resolve(reply(status)), ms));
}

describe('SsrfProbeEngine', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  describe('interrogation d’une URL', () => {
    it('rend le statut, le type et le poids annoncés', async () => {
      const ssrf = makeSsrf(() =>
        Promise.resolve(reply(200, { 'content-length': '2048', 'content-type': 'image/webp' })),
      );

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/i.webp');

      expect(result).toMatchObject({ status: 200, ok: true, contentLength: 2048 });
      expect(result.contentType).toBe('image/webp');
    });

    it('interroge en HEAD — on ne télécharge pas ce qu’on compte', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));

      await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/gros.pdf');

      expect(ssrf.safeFetch).toHaveBeenCalledWith(
        'https://exemple.fr/gros.pdf',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it.each([403, 405, 501])('REPREND en GET après un %i', async status => {
      // Ces statuts visent la MÉTHODE, pas la ressource : s'y arrêter
      // compterait comme cassés des liens parfaitement valides.
      const ssrf = makeSsrf((_url: string, options?: { method?: string }) =>
        Promise.resolve(reply(options?.method === 'HEAD' ? status : 200)),
      );

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/page');

      expect(result.status).toBe(200);
      expect(ssrf.safeFetch).toHaveBeenCalledTimes(2);
    });

    it('NE REPREND PAS un 404 en GET — la réponse est déjà la vérité', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(404)));

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/absent');

      expect(result.status).toBe(404);
      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
    });

    it('ignore un Content-Length non numérique au lieu de propager NaN', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200, { 'content-length': 'inconnu' })));

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/i.png');

      expect(result.contentLength).toBeNull();
    });
  });

  describe('échecs', () => {
    it('DISTINGUE un refus de la politique SSRF d’une panne réseau', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new SsrfBlockedError('adresse privée')));

      const { result } = await new SsrfProbeEngine(ssrf).resolve('http://127.0.0.1/admin');

      expect(result.blocked).toBe(true);
      expect(result.ok).toBe(false);
    });

    it('ne recopie JAMAIS le message de l’exception dans le rapport', async () => {
      // Une erreur d'undici nomme des hôtes et des chemins internes ; un
      // rapport est relu par des comptes qui n'ont pas à les connaître.
      const ssrf = makeSsrf(() => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:8080')));

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/x');

      expect(result.error).toBe('Hôte injoignable');
      expect(result.error).not.toContain('10.1.2.3');
    });

    it('nomme un délai dépassé pour ce qu’il est', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      const ssrf = makeSsrf(() => Promise.reject(abort));

      const { result } = await new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/lent');

      expect(result.error).toBe('Délai dépassé');
    });

    it('ne laisse pas une URL injoignable lever', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new Error('boum')));

      await expect(
        new SsrfProbeEngine(ssrf).resolve('https://exemple.fr/x'),
      ).resolves.toMatchObject({ result: { ok: false } });
    });
  });

  describe('déduplication', () => {
    it('ne sort qu’UNE FOIS pour la même URL', async () => {
      // Le logo d'un CDN apparaît sur chaque page d'un sitemap : sans cache,
      // un scan de cent pages le vérifierait cent fois.
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      const engine = new SsrfProbeEngine(ssrf);

      const first = await engine.resolve('https://cdn.exemple.fr/logo.svg');
      const second = await engine.resolve('https://cdn.exemple.fr/logo.svg');

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
      expect(first.billable).toBe(true);
      expect(second.billable).toBe(false);
    });

    it('PARTAGE une requête déjà en vol', async () => {
      // Le cache n'est écrit qu'au retour : deux critères qui demandent la même
      // URL en même temps émettraient deux requêtes sans ce partage.
      const ssrf = makeSsrf(() => slow(200, 10));
      const engine = new SsrfProbeEngine(ssrf);

      const [first, second] = await Promise.all([
        engine.resolve('https://exemple.fr/menu'),
        engine.resolve('https://exemple.fr/menu'),
      ]);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
      expect([first?.billable, second?.billable].filter(Boolean)).toHaveLength(1);
    });

    it('mémorise un ÉCHEC beaucoup moins longtemps qu’un succès', async () => {
      // Un hôte qui expire une fois n'est pas mort pour dix minutes : le
      // condamner ferait apparaître le même lien cassé sur tout un lot.
      vi.useFakeTimers();
      try {
        const ssrf = makeSsrf(() => Promise.reject(new Error('panne')));
        const engine = new SsrfProbeEngine(ssrf);

        await engine.resolve('https://exemple.fr/instable');
        vi.advanceTimersByTime(90_000);
        const retried = await engine.resolve('https://exemple.fr/instable');

        expect(ssrf.safeFetch).toHaveBeenCalledTimes(2);
        expect(retried.billable).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('garde un SUCCÈS au-delà de ce même délai', async () => {
      vi.useFakeTimers();
      try {
        const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
        const engine = new SsrfProbeEngine(ssrf);

        await engine.resolve('https://exemple.fr/stable');
        vi.advanceTimersByTime(90_000);
        await engine.resolve('https://exemple.fr/stable');

        expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('concurrence', () => {
    it('BORNE les requêtes simultanées du processus, pas celles d’un appel', async () => {
      // Quatre critères réseau travaillent de front : un plafond par appel
      // laisserait passer quatre fois plus de connexions que voulu.
      let inFlight = 0;
      let peak = 0;
      const ssrf = makeSsrf((() => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise(resolve =>
          setTimeout(() => {
            inFlight -= 1;
            resolve(reply(200));
          }, 5),
        );
      }) as unknown as Ssrf['safeFetch']);

      const engine = new SsrfProbeEngine(ssrf, { concurrency: 2 });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => engine.resolve(`https://exemple.fr/${i}`)),
      );

      expect(peak).toBeLessThanOrEqual(2);
    });
  });

  describe('lecture d’un corps texte', () => {
    it('rend le texte et le statut', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'User-agent: *');

      const { result, body } = await new SsrfProbeEngine(ssrf).text(
        'https://exemple.fr/robots.txt',
        1024,
      );

      expect(body).toBe('User-agent: *');
      expect(result.status).toBe(200);
    });

    it('rend un corps nul quand la requête échoue', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new Error('panne')));

      const { result, body } = await new SsrfProbeEngine(ssrf).text('https://exemple.fr/x', 1024);

      expect(body).toBeNull();
      expect(result.ok).toBe(false);
    });

    it('ne retélécharge pas le même corps', async () => {
      // La page de mentions légales est la même sur tout un site : la relire à
      // chaque page d'un lot est du réseau dépensé pour rien.
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'Hébergeur : OVH');
      const engine = new SsrfProbeEngine(ssrf);

      await engine.text('https://exemple.fr/mentions', 1024);
      const again = await engine.text('https://exemple.fr/mentions', 1024);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
      expect(again.body).toBe('Hébergeur : OVH');
      expect(again.billable).toBe(false);
    });

    it('distingue deux lectures de plafonds différents', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'texte');
      const engine = new SsrfProbeEngine(ssrf);

      await engine.text('https://exemple.fr/page', 1024);
      await engine.text('https://exemple.fr/page', 8192);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(2);
    });

    it('NE MÉMORISE PAS un corps volumineux — le cache n’est pas un entrepôt', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'x'.repeat(300_000));
      const engine = new SsrfProbeEngine(ssrf);

      await engine.text('https://exemple.fr/enorme', 1_000_000);
      await engine.text('https://exemple.fr/enorme', 1_000_000);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(2);
    });

    it('PARTAGE une lecture déjà en vol', async () => {
      const ssrf = makeSsrf(() => slow(200, 10), 'corps');
      const engine = new SsrfProbeEngine(ssrf);

      await Promise.all([
        engine.text('https://exemple.fr/legal', 1024),
        engine.text('https://exemple.fr/legal', 1024),
      ]);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
    });
  });
});
