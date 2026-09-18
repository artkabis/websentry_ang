import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'node:dns/promises';
import { type AppConfigService } from '../config/app-config.service.js';
import { SsrfBlockedError, SsrfService } from './ssrf.service.js';

/**
 * La résolution DNS est simulée : la politique SSRF doit être vérifiable sans
 * dépendre d'Internet ni d'un enregistrement DNS hostile réel, et sans devenir
 * instable en CI.
 */
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookup = vi.mocked(dns.lookup);

function configStub(): AppConfigService {
  return {
    fetchUserAgent: 'WebSentry-Test/2.0',
    fetchTimeoutMs: 5000,
  } as AppConfigService;
}

/** Réponse de `lookup(host, { all: true })`. */
function resolvesTo(...addresses: string[]) {
  lookup.mockResolvedValue(
    addresses.map(address => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })) as never,
  );
}

describe('SsrfService', () => {
  let service: SsrfService;

  beforeEach(() => {
    service = new SsrfService(configStub());
  });

  afterEach(() => {
    service.reset();
  });

  describe('protocoles', () => {
    it.each([
      ['file:///etc/passwd', 'file'],
      ['gopher://exemple.fr/', 'gopher'],
      ['ftp://exemple.fr/', 'ftp'],
      ['data:text/plain,bonjour', 'data'],
      ['javascript:alert(1)', 'javascript'],
    ])('refuse %s (schéma %s)', async url => {
      await expect(service.assertPublicUrl(url)).rejects.toThrow(SsrfBlockedError);
    });

    it('refuse une URL syntaxiquement invalide', async () => {
      await expect(service.assertPublicUrl('pas une url')).rejects.toThrow(SsrfBlockedError);
    });

    it('accepte http et https vers un hôte public', async () => {
      resolvesTo('93.184.216.34');
      await expect(service.assertPublicUrl('http://exemple.fr/')).resolves.toBeUndefined();
      await expect(service.assertPublicUrl('https://exemple.fr/')).resolves.toBeUndefined();
    });
  });

  describe('IP littérales — aucune résolution DNS nécessaire', () => {
    it.each([
      'http://127.0.0.1/',
      'http://localhost.127.0.0.1.nip.io/'.replace('localhost.127.0.0.1.nip.io', '10.0.0.5'),
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
    ])('refuse %s', async url => {
      await expect(service.assertPublicUrl(url)).rejects.toThrow(
        /adresses IP privées non autorisé/,
      );
      expect(lookup).not.toHaveBeenCalled();
    });

    it('accepte une IP publique littérale sans interroger le DNS', async () => {
      await expect(service.assertPublicUrl('https://8.8.8.8/')).resolves.toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('accepte une IPv6 publique entre crochets', async () => {
      await expect(
        service.assertPublicUrl('https://[2001:4860:4860::8888]/'),
      ).resolves.toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('résolution DNS', () => {
    it('refuse un hôte résolvant vers une adresse privée', async () => {
      resolvesTo('127.0.0.1');
      await expect(service.assertPublicUrl('https://interne.exemple.fr/')).rejects.toThrow(
        /adresses IP privées non autorisé/,
      );
    });

    it('refuse dès qu’UNE SEULE adresse du jeu est privée', async () => {
      // Contournement multi-enregistrements : un domaine qui publie à la fois une
      // IP publique et 127.0.0.1 laisserait passer une politique « au moins une
      // adresse publique ». La politique retenue est la plus conservatrice.
      resolvesTo('93.184.216.34', '127.0.0.1');
      await expect(service.assertPublicUrl('https://piege.exemple.fr/')).rejects.toThrow(
        /adresses IP privées non autorisé/,
      );
    });

    it('refuse un jeu contenant l’adresse de métadonnées cloud', async () => {
      resolvesTo('93.184.216.34', '169.254.169.254');
      await expect(service.assertPublicUrl('https://piege.exemple.fr/')).rejects.toThrow(
        SsrfBlockedError,
      );
    });

    it('accepte un jeu entièrement public', async () => {
      resolvesTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
      await expect(service.assertPublicUrl('https://exemple.fr/')).resolves.toBeUndefined();
    });

    it('refuse quand le nom d’hôte ne résout pas', async () => {
      lookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(service.assertPublicUrl('https://inexistant.exemple/')).rejects.toThrow(
        /Impossible de résoudre/,
      );
    });

    it('refuse quand la résolution renvoie une liste vide', async () => {
      lookup.mockResolvedValue([] as never);
      await expect(service.assertPublicUrl('https://vide.exemple.fr/')).rejects.toThrow(
        /Impossible de résoudre/,
      );
    });
  });

  describe('cache de résolution', () => {
    it('réutilise une résolution validée pendant sa fenêtre de validité', async () => {
      resolvesTo('93.184.216.34');
      await service.assertPublicUrl('https://exemple.fr/a');
      await service.assertPublicUrl('https://exemple.fr/b');
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('ne partage jamais une entrée entre deux hôtes distincts', async () => {
      resolvesTo('93.184.216.34');
      await service.assertPublicUrl('https://un.exemple.fr/');
      await service.assertPublicUrl('https://deux.exemple.fr/');
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('ne met JAMAIS en cache une résolution refusée', async () => {
      // Sinon un refus deviendrait une entrée réutilisable, et l'inverse aussi.
      resolvesTo('127.0.0.1');
      await expect(service.assertPublicUrl('https://interne.exemple.fr/')).rejects.toThrow();
      await expect(service.assertPublicUrl('https://interne.exemple.fr/')).rejects.toThrow();
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('vide le cache sur reset()', async () => {
      resolvesTo('93.184.216.34');
      await service.assertPublicUrl('https://exemple.fr/');
      service.reset();
      await service.assertPublicUrl('https://exemple.fr/');
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  });

  describe('readTextCapped', () => {
    /** Réponse minimale : seuls `headers` et `body` sont consultés. */
    function responseWith(chunks: string[], contentLength?: string) {
      const encoder = new TextEncoder();
      let i = 0;
      const stream = {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              i < chunks.length
                ? { done: false, value: encoder.encode(chunks[i++]) }
                : { done: true, value: undefined },
            ),
          releaseLock: () => undefined,
        }),
        cancel: () => Promise.resolve(),
      };
      return {
        headers: { get: (k: string) => (k === 'content-length' ? (contentLength ?? null) : null) },
        body: stream,
      } as never;
    }

    it('lit un corps sous le plafond', async () => {
      await expect(service.readTextCapped(responseWith(['bon', 'jour']))).resolves.toBe('bonjour');
    });

    it('refuse AVANT lecture quand Content-Length dépasse le plafond', async () => {
      await expect(
        service.readTextCapped(responseWith(['x'], String(20 * 1024 * 1024))),
      ).rejects.toThrow(/trop volumineuse/);
    });

    it('interrompt la lecture d’un corps trop gros SANS Content-Length déclaré', async () => {
      // Content-Length est facultatif et falsifiable : le plafond doit aussi
      // s'appliquer en flux, sinon un serveur hostile le contourne en l'omettant.
      await expect(service.readTextCapped(responseWith(['a'.repeat(100)]), 10)).rejects.toThrow(
        /trop volumineuse/,
      );
    });

    it('avale une erreur d’annulation en fin de lecture', async () => {
      const encoder = new TextEncoder();
      let done = false;
      const res = {
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: encoder.encode('ok') });
            },
            releaseLock: () => undefined,
          }),
          // L'annulation peut échouer si le flux est déjà clos : ce n'est pas
          // une erreur pour l'appelant, qui a bien reçu son contenu.
          cancel: () => Promise.reject(new Error('flux déjà clos')),
        },
      } as never;

      await expect(service.readTextCapped(res)).resolves.toBe('ok');
    });

    it('retourne une chaîne vide quand la réponse n’a pas de corps', async () => {
      const res = { headers: { get: () => null }, body: null } as never;
      await expect(service.readTextCapped(res)).resolves.toBe('');
    });

    it('ignore les morceaux vides du flux', async () => {
      const encoder = new TextEncoder();
      const values = [encoder.encode('ab'), undefined, encoder.encode('cd')];
      let i = 0;
      const res = {
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () =>
              Promise.resolve(
                i < values.length ? { done: false, value: values[i++] } : { done: true },
              ),
            releaseLock: () => undefined,
          }),
          cancel: () => Promise.resolve(),
        },
      } as never;

      await expect(service.readTextCapped(res)).resolves.toBe('abcd');
    });
  });
});
