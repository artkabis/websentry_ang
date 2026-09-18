import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'node:dns/promises';
import * as undici from 'undici';
import type * as Undici from 'undici';
import { type AppConfigService } from '../config/app-config.service.js';
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
  const actual = await vi.importActual<typeof Undici>('undici');
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
    });
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

    it('avale une erreur d’annulation dans dispose() — elle ne doit rien casser', async () => {
      const res = response(200);
      (res as unknown as { body: { cancel: ReturnType<typeof vi.fn> } }).body.cancel = vi
        .fn()
        .mockRejectedValue(new Error('corps déjà fermé'));
      fetch.mockResolvedValue(res);

      const result = await service.safeFetch('https://exemple.fr/');
      expect(() => result.dispose()).not.toThrow();
    });

    it('libère le corps non lu via dispose()', async () => {
      const res = response(200);
      fetch.mockResolvedValue(res);
      const result = await service.safeFetch('https://exemple.fr/');
      result.dispose();
      expect(
        (res as unknown as { body: { cancel: ReturnType<typeof vi.fn> } }).body.cancel,
      ).toHaveBeenCalled();
    });
  });

  describe('épinglage — le mécanisme anti-rebinding lui-même', () => {
    /** Récupère la fonction `lookup` injectée dans l'agent épinglé. */
    function pinnedLookup(): (
      hostname: string,
      options: { all?: boolean },
      cb: (err: unknown, address: unknown, family?: number) => void,
    ) => void {
      const created = Agent.mock.results[0]?.value as FakeAgent;
      const options = created.options as {
        connect: { lookup: (h: string, o: { all?: boolean }, cb: never) => void };
      };
      return options.connect.lookup as never;
    }

    beforeEach(() => {
      resolvesTo('93.184.216.34', '93.184.216.35');
    });

    it('court-circuite la résolution d’undici avec les SEULES adresses validées', async () => {
      // C'est ici que se ferme la fenêtre de DNS rebinding : undici ne re-résout
      // jamais le nom, il reçoit les adresses déjà contrôlées.
      await service.safeFetch('https://exemple.fr/');

      const received: unknown[] = [];
      pinnedLookup()('exemple.fr', { all: true }, (_err, address) => received.push(address));

      expect(received[0]).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ]);
    });

    it('sert la première adresse validée en mode simple', async () => {
      await service.safeFetch('https://exemple.fr/');

      let address: unknown;
      let family: unknown;
      pinnedLookup()('exemple.fr', {}, (_err, a, f) => {
        address = a;
        family = f;
      });

      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
    });

    it('ne consulte JAMAIS le nom d’hôte qu’on lui passe', async () => {
      // Même sollicité avec un autre nom, l'agent ne rend que les adresses
      // épinglées : un rebinding en cours de connexion reste sans effet.
      await service.safeFetch('https://exemple.fr/');

      let address: unknown;
      pinnedLookup()('attaquant.example', {}, (_err, a) => {
        address = a;
      });

      expect(address).toBe('93.184.216.34');
    });
  });

  describe('cache d’agents', () => {
    it('recrée un agent dont l’entrée a expiré, et détruit l’ancien', async () => {
      vi.useFakeTimers();
      try {
        resolvesTo('93.184.216.34');
        await service.safeFetch('https://exemple.fr/a');
        const premier = Agent.mock.results[0]?.value as FakeAgent;

        // Au-delà de la durée de vie d'une entrée (30 s), l'agent est renouvelé.
        vi.advanceTimersByTime(31_000);
        await service.safeFetch('https://exemple.fr/b');

        expect(Agent).toHaveBeenCalledTimes(2);
        expect(premier.destroy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('survit à une destruction d’agent qui échoue', async () => {
      // Un agent déjà détruit rejette : ce n'est pas une erreur pour l'appelant,
      // le cache doit simplement poursuivre son nettoyage.
      resolvesTo('93.184.216.34');
      await service.safeFetch('https://exemple.fr/');
      const agent = Agent.mock.results[0]?.value as FakeAgent;
      agent.destroy.mockRejectedValue(new Error('agent déjà détruit'));

      expect(() => service.reset()).not.toThrow();
    });

    it('survit à un échec de destruction lors de l’expiration d’une entrée', async () => {
      vi.useFakeTimers();
      try {
        resolvesTo('93.184.216.34');
        await service.safeFetch('https://exemple.fr/a');
        const premier = Agent.mock.results[0]?.value as FakeAgent;
        premier.destroy.mockRejectedValue(new Error('agent déjà détruit'));

        vi.advanceTimersByTime(31_000);
        await expect(service.safeFetch('https://exemple.fr/b')).resolves.toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('survit à un échec de destruction lors d’une éviction', async () => {
      resolvesTo('93.184.216.34');
      for (let i = 0; i < 260; i++) {
        lookup.mockResolvedValue([{ address: `93.184.${i % 200}.${i % 250}`, family: 4 }] as never);
        if (i === 0) {
          await service.safeFetch('https://hote-0.exemple.fr/');
          const premier = Agent.mock.results[0]?.value as FakeAgent;
          premier.destroy.mockRejectedValue(new Error('agent déjà détruit'));
          continue;
        }
        await expect(service.safeFetch(`https://hote-${i}.exemple.fr/`)).resolves.toBeDefined();
      }
    });

    it('détruit les agents en cache sur reset()', async () => {
      resolvesTo('93.184.216.34');
      await service.safeFetch('https://exemple.fr/');
      const agent = Agent.mock.results[0]?.value as FakeAgent;

      service.reset();
      expect(agent.destroy).toHaveBeenCalled();
    });

    it('ÉVINCE le plus ancien agent quand le pool est saturé', async () => {
      // Sans éviction, un scan touchant des milliers d'hôtes ferait croître le
      // pool de sockets sans borne.
      resolvesTo('93.184.216.34');
      for (let i = 0; i < 260; i++) {
        lookup.mockResolvedValue([{ address: `93.184.${i % 200}.${i % 250}`, family: 4 }] as never);
        await service.safeFetch(`https://hote-${i}.exemple.fr/`);
      }

      const premier = Agent.mock.results[0]?.value as FakeAgent;
      expect(premier.destroy).toHaveBeenCalled();
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
      expect(result.redirectChain).toEqual([{ url: 'https://exemple.fr/depart', status: 302 }]);
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
      await expect(service.safeFetch('https://exemple.fr/', { maxRedirects: 2 })).rejects.toThrow(
        /Trop de redirections/,
      );
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
