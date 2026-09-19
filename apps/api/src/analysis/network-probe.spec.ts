import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SsrfBlockedError,
  type SafeFetchResult,
  type SsrfService,
} from '../security/ssrf.service.js';
import { SsrfNetworkProbe, clearProbeCache } from './network-probe.js';

/** Réponse minimale — seuls le statut et les en-têtes intéressent la sonde. */
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

describe('SsrfNetworkProbe', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  describe('vérification d’une URL', () => {
    it('rend le statut, le type et le poids annoncés', async () => {
      const ssrf = makeSsrf(() =>
        Promise.resolve(reply(200, { 'content-length': '4096', 'content-type': 'image/webp' })),
      );

      const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/i.webp');

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.contentLength).toBe(4096);
      expect(result.contentType).toBe('image/webp');
    });

    it('interroge en HEAD, pas en GET — on ne télécharge pas ce qu’on compte', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/gros.pdf');

      expect(ssrf.safeFetch).toHaveBeenCalledWith(
        'https://exemple.fr/gros.pdf',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it.each([403, 405, 501])(
      'REPREND en GET quand le serveur refuse la méthode (%i)',
      async status => {
        // La v1 ne réessayait que sur 405 et comptait donc comme cassés des
        // liens parfaitement valides derrière un WAF qui répond 403 à un HEAD.
        const ssrf = makeSsrf((_url, opts) =>
          Promise.resolve(opts?.method === 'HEAD' ? reply(status) : reply(200)),
        );

        const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/page');

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
      },
    );

    it('NE REPREND PAS un 404 en GET — la réponse est déjà la vérité', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(404)));

      const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/absent');

      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
    });

    it('ignore un Content-Length non numérique au lieu de propager NaN', async () => {
      // `Number('abc')` vaut NaN, et NaN rend fausse TOUTE comparaison de
      // poids sans jamais lever : l'image serait déclarée conforme en silence.
      const ssrf = makeSsrf(() => Promise.resolve(reply(200, { 'content-length': 'abc' })));

      const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/i.png');

      expect(result.contentLength).toBeNull();
    });
  });

  describe('échecs', () => {
    it('DISTINGUE un refus de la politique SSRF d’une panne réseau', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new SsrfBlockedError('IP privée')));

      const result = await new SsrfNetworkProbe(ssrf).check('http://127.0.0.1/admin');

      expect(result.blocked).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
    });

    it('ne recopie JAMAIS le message de l’exception dans le rapport', async () => {
      // Un rapport est relu par des comptes qui n'ont pas à connaître les hôtes
      // internes : le message est choisi par TYPE d'erreur, jamais hérité.
      const ssrf = makeSsrf(() => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:8080')));

      const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/x');

      expect(result.error).toBe('Hôte injoignable');
      expect(result.error).not.toContain('10.1.2.3');
    });

    it('nomme un délai dépassé pour ce qu’il est', async () => {
      const timeout = new Error('délai');
      timeout.name = 'TimeoutError';
      const ssrf = makeSsrf(() => Promise.reject(timeout));

      const result = await new SsrfNetworkProbe(ssrf).check('https://exemple.fr/lent');

      expect(result.error).toBe('Délai dépassé');
    });

    it('ne laisse pas une URL injoignable faire tomber le critère', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new Error('panne')));

      // Le contrat tient dans cette absence de `rejects` : la sonde REND
      // l'échec, elle ne le propage pas.
      await expect(new SsrfNetworkProbe(ssrf).check('https://exemple.fr/x')).resolves.toMatchObject(
        {
          ok: false,
        },
      );
    });
  });

  describe('budget de requêtes', () => {
    it('REFUSE de sortir au-delà du quota de l’analyse', async () => {
      // Une page hostile listant mille liens ne doit pas transformer le serveur
      // en amplificateur : le quota se décompte avant la requête, pas après.
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      const probe = new SsrfNetworkProbe(ssrf, { budget: 2 });

      const results = await probe.checkMany([
        'https://exemple.fr/1',
        'https://exemple.fr/2',
        'https://exemple.fr/3',
      ]);

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(2);
      expect(results[2]?.error).toContain('Quota');
      expect(probe.remaining).toBe(0);
    });

    it('ne mémorise PAS un quota épuisé — l’analyse suivante a le sien', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      await new SsrfNetworkProbe(ssrf, { budget: 0 }).check('https://exemple.fr/a');

      const second = await new SsrfNetworkProbe(ssrf, { budget: 5 }).check('https://exemple.fr/a');

      expect(second.ok).toBe(true);
    });

    it('un corps texte consomme aussi du quota', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'User-agent: *');
      const probe = new SsrfNetworkProbe(ssrf, { budget: 1 });

      const first = await probe.fetchText('https://exemple.fr/robots.txt');
      const second = await probe.fetchText('https://exemple.fr/autre.txt');

      expect(first.body).toBe('User-agent: *');
      expect(second.body).toBeNull();
      expect(second.result.error).toContain('Quota');
    });
  });

  describe('cache', () => {
    it('ne sort qu’UNE FOIS pour la même URL', async () => {
      // Le logo d'un CDN apparaît sur chaque page d'un sitemap : sans cache,
      // un scan de cent pages le vérifierait cent fois.
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      const probe = new SsrfNetworkProbe(ssrf);

      await probe.check('https://cdn.exemple.fr/logo.svg');
      await probe.check('https://cdn.exemple.fr/logo.svg');

      expect(ssrf.safeFetch).toHaveBeenCalledTimes(1);
    });

    it('un résultat mémorisé ne consomme pas de quota', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));
      const probe = new SsrfNetworkProbe(ssrf, { budget: 1 });

      await probe.check('https://exemple.fr/a');
      const again = await probe.check('https://exemple.fr/a');

      expect(again.ok).toBe(true);
      expect(probe.remaining).toBe(0);
    });
  });

  describe('vérifications multiples', () => {
    it('rend les résultats DANS L’ORDRE des URL fournies', async () => {
      // Le pool est continu : les réponses n'arrivent pas dans l'ordre des
      // départs, et un rapport qui attribue le statut d'une URL à une autre est
      // pire qu'un rapport absent.
      const delays: Record<string, number> = {
        'https://exemple.fr/lent': 20,
        'https://exemple.fr/moyen': 10,
        'https://exemple.fr/rapide': 0,
      };
      const ssrf = makeSsrf(((url: string) => {
        const status = url.endsWith('lent') ? 404 : 200;
        return new Promise(resolve => setTimeout(() => resolve(reply(status)), delays[url] ?? 0));
      }) as unknown as Ssrf['safeFetch']);

      const results = await new SsrfNetworkProbe(ssrf).checkMany([
        'https://exemple.fr/lent',
        'https://exemple.fr/moyen',
        'https://exemple.fr/rapide',
      ]);

      expect(results.map(r => r.status)).toEqual([404, 200, 200]);
    });

    it('rend un tableau vide sans sortir sur le réseau', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)));

      expect(await new SsrfNetworkProbe(ssrf).checkMany([])).toEqual([]);
      expect(ssrf.safeFetch).not.toHaveBeenCalled();
    });

    it('BORNE le nombre de requêtes simultanées', async () => {
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

      const urls = Array.from({ length: 12 }, (_, i) => `https://exemple.fr/${i}`);
      await new SsrfNetworkProbe(ssrf, { concurrency: 3 }).checkMany(urls);

      expect(peak).toBeLessThanOrEqual(3);
    });
  });

  describe('lecture d’un corps texte', () => {
    it('rend le texte et le statut', async () => {
      const ssrf = makeSsrf(() => Promise.resolve(reply(200)), 'Sitemap: /s.xml');

      const { result, body } = await new SsrfNetworkProbe(ssrf).fetchText(
        'https://exemple.fr/robots.txt',
      );

      expect(result.status).toBe(200);
      expect(body).toBe('Sitemap: /s.xml');
    });

    it('rend un corps nul quand la requête échoue', async () => {
      const ssrf = makeSsrf(() => Promise.reject(new SsrfBlockedError('bloqué')));

      const { result, body } = await new SsrfNetworkProbe(ssrf).fetchText(
        'http://169.254.169.254/',
      );

      expect(body).toBeNull();
      expect(result.blocked).toBe(true);
    });
  });
});
