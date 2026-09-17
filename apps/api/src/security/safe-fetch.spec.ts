import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'node:dns/promises';
import * as undici from 'undici';
import { AppConfigService } from '../config/app-config.service.js';
import { SsrfBlockedError, SsrfService } from './ssrf.service.js';

/**
 * `safeFetch` est testé avec DNS et couche HTTP simulés.
 *
 * Un vrai serveur local ne conviendrait pas : il écouterait sur 127.0.0.1, que la
 * politique SSRF bloque précisément. Simuler permet en outre de rejouer des
 * scénarios impossibles à provoquer sur commande — un 302 vers l'adresse de
 * métadonnées cloud, par exemple.
 */
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: vi.fn(), Agent: vi.fn() };
});

const lookup = vi.mocked(dns.lookup);
const fetch = vi.mocked(undici.fetch);
const Agent = vi.mocked(undici.Agent);

/**
 * Agent factice. `restoreMocks` remet les mocks à nu entre chaque test : les
 * implémentations sont donc réinstallées dans `beforeEach`, pas dans la fabrique
 * de `vi.mock`, qui ne s'exécute qu'une fois.
 */
class FakeAgent {
  readonly destroy = vi.fn().mockResolvedValue(undefined);
  constructor(readonly options: unknown) {}
}

function configStub(): AppConfigService {
  return { fetchUserAgent: 'WebSentry-Test/2.0', fetchTimeoutMs: 5000 } as AppConfigService;
}

function resolvesTo(...addresses: string[]) {
  lookup.mockResolvedValue(
    addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
  );
}

/** Réponse undici minimale — seuls `status`, `headers` et `body` sont consultés. */
function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  } as never;
}

describe('SsrfService.safeFetch', () => {
  let service: SsrfService;

  beforeEach(() => {
    // Fonction classique et non fléchée : `new Agent(...)` a besoin d'un
    // constructeur, ce qu'une fonction fléchée n'est pas.
    Agent.mockImplementation(function (options: unknown) {
      return new FakeAgent(options);
    } as never);
    service = new SsrfService(configStub());
    resolvesTo('93.184.216.34');
    fetch.mockResolvedValue(response(200));
  });

  afterEach(() => {
    service.reset();
  });

  describe('requête simple', () => {
    it('retourne la réponse et l’URL finale', async () => {
      const result = await service.safeFetch('https://exemple.fr/page');
      expect(result.response.status).toBe(200);
      expect(result.finalUrl).toBe('https://exemple.fr/page');
      expect(result.redirected).toBe(false);
      expect(result.redirectChain).toEqual([]);
    });

    it('envoie le User-Agent configuré et suit les redirections MANUELLEMENT', async () => {
      // `redirect: 'manual'` est essentiel : en mode automatique, undici suivrait
      // un 302 vers une IP privée sans repasser par la validation.
      await service.safeFetch('https://exemple.fr/');
      const [, init] = fetch.mock.calls[0] as [string, Record<string, unknown>];
      expect(init.redirect).toBe('manual');
      expect((init.headers as Record<string, string>)['User-Agent']).toBe('WebSentry-Test/2.0');
    });

    it('permet de surcharger la méthode et les en-têtes', async () => {
      await service.safeFetch('https://exemple.fr/', {
        method: 'HEAD',
        headers: { 'X-Test': 'oui' },
      });
      const [, init] = fetch.mock.calls[0] as [string, Record<string, unknown>];
      expect(init.method).toBe('HEAD');
      expect((init.headers as Record<string, string>)['X-Test']).toBe('oui');
    });

    it('épingle la connexion à un agent dédié pour un hôte résolu par DNS', async () => {
      await service.safeFetch('https://exemple.fr/');
      const [, init] = fetch.mock.calls[0] as [string, Record<string, unknown>];
      expect(init.dispatcher).toBeDefined();
    });

    it('n’épingle PAS pour une IP littérale — il n’y a rien à re-résoudre', async () => {
      await service.safeFetch('https://93.184.216.34/');
      const [, init] = fetch.mock.calls[0] as [string, Record<string, unknown>];
      expect(init.dispatcher).toBeUndefined();
    });

    it('réutilise l’agent épinglé entre deux requêtes vers le même hôte', async () => {
      await service.safeFetch('https://exemple.fr/a');
      await service.safeFetch('https://exemple.fr/b');
      const first = (fetch.mock.calls[0] as [string, Record<string, unknown>])[1].dispatcher;
      const second = (fetch.mock.calls[1] as [string, Record<string, unknown>])[1].dispatcher;
      expect(first).toBe(second);
    });

    it('libère le corps non lu via dispose()', async () => {
      const res = response(200);
      fetch.mockResolvedValue(res);
      const result = await service.safeFetch('https://exemple.fr/');
      result.dispose();
      expect((res as unknown as { body: { cancel: ReturnType<typeof vi.fn> } }).body.cancel)
        .toHaveBeenCalled();
    });
  });

  describe('redirections', () => {
    it('suit une redirection vers une destination publique', async () => {
      fetch
        .mockResolvedValueOnce(response(302, { location: 'https://exemple.fr/final' }))
        .mockResolvedValueOnce(response(200));

      const result = await service.safeFetch('https://exemple.fr/depart');

      expect(result.finalUrl).toBe('https://exemple.fr/final');
      expect(result.redirected).toBe(true);
      expect(result.redirectChain).toEqual([
        { url: 'https://exemple.fr/depart', status: 302 },
      ]);
    });

    it('BLOQUE une redirection vers une IP privée — le cœur de la défense', async () => {
      // Sans re-validation par saut, un 302 vers l'adresse de métadonnées cloud
      // contournerait tout le dispositif.
      fetch.mockResolvedValueOnce(
        response(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
      );

      await expect(service.safeFetch('https://exemple.fr/piege')).rejects.toThrow(
        /adresses IP privées non autorisé/,
      );
    });

    it('BLOQUE une redirection vers un schéma non HTTP', async () => {
      fetch.mockResolvedValueOnce(response(302, { location: 'file:///etc/passwd' }));
      await expect(service.safeFetch('https://exemple.fr/piege')).rejects.toThrow(SsrfBlockedError);
    });

    it('BLOQUE une redirection vers un hôte résolvant en privé', async () => {
      fetch.mockResolvedValueOnce(response(302, { location: 'https://interne.exemple.fr/' }));
      lookup
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
        .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);

      await expect(service.safeFetch('https://exemple.fr/piege')).rejects.toThrow(
        /adresses IP privées non autorisé/,
      );
    });

    it('résout une Location relative contre l’URL courante', async () => {
      fetch
        .mockResolvedValueOnce(response(301, { location: '/ailleurs' }))
        .mockResolvedValueOnce(response(200));

      const result = await service.safeFetch('https://exemple.fr/depart');
      expect(result.finalUrl).toBe('https://exemple.fr/ailleurs');
    });

    it('retourne la réponse telle quelle si le 3xx n’a pas de Location', async () => {
      fetch.mockResolvedValueOnce(response(302));
      const result = await service.safeFetch('https://exemple.fr/');
      expect(result.response.status).toBe(302);
      expect(result.redirected).toBe(false);
    });

    it('refuse une boucle de redirections', async () => {
      fetch.mockResolvedValue(response(302, { location: 'https://exemple.fr/boucle' }));
      await expect(service.safeFetch('https://exemple.fr/boucle')).rejects.toThrow(
        /Trop de redirections/,
      );
    });

    it('respecte un plafond de redirections réduit', async () => {
      fetch.mockResolvedValue(response(302, { location: 'https://exemple.fr/suivant' }));
      await expect(
        service.safeFetch('https://exemple.fr/', { maxRedirects: 2 }),
      ).rejects.toThrow(/Trop de redirections/);
      expect(fetch).toHaveBeenCalledTimes(3); // tentative initiale + 2 sauts
    });

    it('re-valide CHAQUE saut, pas seulement le premier', async () => {
      fetch
        .mockResolvedValueOnce(response(302, { location: 'https://etape2.exemple.fr/' }))
        .mockResolvedValueOnce(response(302, { location: 'http://127.0.0.1/' }));

      await expect(service.safeFetch('https://exemple.fr/')).rejects.toThrow(SsrfBlockedError);
    });
  });

  describe('validation préalable', () => {
    it('refuse AVANT d’émettre la moindre requête', async () => {
      await expect(service.safeFetch('http://127.0.0.1/')).rejects.toThrow(SsrfBlockedError);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuse un schéma non HTTP sans émettre de requête', async () => {
      await expect(service.safeFetch('file:///etc/passwd')).rejects.toThrow(SsrfBlockedError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
