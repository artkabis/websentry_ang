import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { SsrfService } from '../security/ssrf.service.js';
import { PageFetcherService, rehydratePage } from './page-fetcher.service.js';

const HTML = '<html lang="fr"><head><title>Accueil</title></head><body><p>x</p></body></html>';

function build(over: { html?: string; status?: number; headers?: Record<string, string> } = {}) {
  const dispose = vi.fn();
  const headers = new Map(Object.entries(over.headers ?? { 'Content-Type': 'text/html' }));

  const ssrf = {
    safeFetch: vi.fn().mockResolvedValue({
      response: {
        status: over.status ?? 200,
        headers: { forEach: (fn: (v: string, k: string) => void) => headers.forEach(fn) },
      },
      finalUrl: 'https://exemple.fr/finale',
      redirectChain: [{ url: 'https://exemple.fr/', status: 301 }],
      redirected: true,
      dispose,
    }),
    readTextCapped: vi.fn().mockResolvedValue(over.html ?? HTML),
  };
  const config = { fetchTimeoutMs: 15_000 };

  return {
    service: new PageFetcherService(
      ssrf as unknown as SsrfService,
      config as unknown as AppConfigService,
    ),
    ssrf,
    dispose,
  };
}

describe('PageFetcherService', () => {
  it('PASSE par la politique SSRF, jamais par fetch directement', async () => {
    // C'est la seule porte de sortie du processus : la contourner, fût-ce pour
    // « juste récupérer le HTML », annulerait toute la protection.
    const t = build();
    await t.service.fetchPage('https://exemple.fr/');
    expect(t.ssrf.safeFetch).toHaveBeenCalledWith('https://exemple.fr/', {
      method: 'GET',
      timeoutMs: 15_000,
    });
  });

  it('retient l’URL FINALE, redirections suivies', async () => {
    const page = await build().service.fetchPage('https://exemple.fr/');
    expect(page.url).toBe('https://exemple.fr/finale');
    expect(page.redirectChain).toHaveLength(1);
  });

  it('détecte plateforme et titre', async () => {
    const page = await build({
      html: '<html><body><div id="dmRoot"></div><title>T</title></body></html>',
    }).service.fetchPage('https://exemple.fr/');
    expect(page.platform).toBe('duda');
    expect(page.title).toBe('T');
  });

  it('normalise la casse des en-têtes', async () => {
    const page = await build({
      headers: { 'Content-Type': 'text/html', SERVER: 'nginx' },
    }).service.fetchPage('https://exemple.fr/');
    expect(page.headers).toEqual({ 'content-type': 'text/html', server: 'nginx' });
  });

  it('borne la lecture du corps', async () => {
    const t = build();
    await t.service.fetchPage('https://exemple.fr/');
    const [, maxBytes] = t.ssrf.readTextCapped.mock.calls[0] as [unknown, number];
    expect(maxBytes).toBeGreaterThan(0);
  });

  it('LIBÈRE la connexion, y compris en cas d’échec de lecture', async () => {
    // Sans cela, un lot de deux cents pages épuise le pool keep-alive.
    const t = build();
    t.ssrf.readTextCapped.mockRejectedValue(new Error('corps illisible'));
    await expect(t.service.fetchPage('https://exemple.fr/')).rejects.toThrow();
    expect(t.dispose).toHaveBeenCalled();
  });

  it('rend une page SÉRIALISABLE — aucune instance Cheerio', async () => {
    // Elle traverse la frontière d'un worker : une instance Cheerio y serait
    // rejetée par l'algorithme de clonage structuré.
    const page = await build().service.fetchPage('https://exemple.fr/');
    expect(() => structuredClone(page)).not.toThrow();
  });
});

describe('rehydratePage', () => {
  it('reconstruit un document interrogeable', () => {
    const page = rehydratePage({
      url: 'https://exemple.fr/',
      html: HTML,
      title: 'Accueil',
      platform: 'generic',
      headers: {},
      statusCode: 200,
      ttfb: 10,
      redirectChain: [],
    });
    expect(page.$('title').text()).toBe('Accueil');
  });
});
