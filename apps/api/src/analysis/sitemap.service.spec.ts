import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { SsrfService } from '../security/ssrf.service.js';
import { SitemapService, originOf } from './sitemap.service.js';

const SITEMAP_XML = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://exemple.fr/</loc><lastmod>2026-06-01</lastmod><priority>1.0</priority></url>
  <url><loc>https://exemple.fr/contact</loc></url>
</urlset>`;

const INDEX_XML = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://exemple.fr/sitemap-1.xml</loc></sitemap>
</sitemapindex>`;

/** Réponses simulées, indexées par URL. */
function build(responses: Record<string, { status?: number; body?: string }> = {}) {
  const dispose = vi.fn();

  const safeFetch = vi.fn((url: string) => {
    const entry = responses[url];
    if (!entry) return Promise.reject(new Error('injoignable'));
    return Promise.resolve({
      response: { status: entry.status ?? 200, body: entry.body },
      finalUrl: url,
      redirectChain: [],
      redirected: false,
      dispose,
    });
  });

  // Le corps est associé à la RÉPONSE et non au statut : deux URL peuvent
  // répondre 200 avec des documents différents — c'est précisément le cas d'un
  // sitemap d'index et de ses enfants.
  const readTextCapped = vi.fn((response: { status: number; body?: string }) =>
    Promise.resolve(response.body ?? ''),
  );

  const ssrf = { safeFetch, readTextCapped };
  const config = { fetchTimeoutMs: 15_000 };
  const service = new SitemapService(
    ssrf as unknown as SsrfService,
    config as unknown as AppConfigService,
  );
  return { service, ssrf, safeFetch, readTextCapped, dispose };
}

describe('originOf', () => {
  it('extrait l’origine', () => {
    expect(originOf('https://exemple.fr/a/b?c=1')).toBe('https://exemple.fr');
  });

  it('rend null sur une URL illisible', () => {
    expect(originOf('pas une url')).toBeNull();
  });
});

describe('SitemapService', () => {
  describe('detect', () => {
    it('PRIORISE la déclaration de robots.txt', async () => {
      // C'est la source que le site publie lui-même : deviner à sa place
      // produirait un résultat différent de ce que voit un moteur.
      const t = build({
        'https://exemple.fr/robots.txt': { body: 'Sitemap: https://exemple.fr/plan.xml' },
      });
      await expect(t.service.detect('https://exemple.fr/page')).resolves.toBe(
        'https://exemple.fr/plan.xml',
      );
    });

    it('lit la déclaration quelle que soit sa casse', async () => {
      const t = build({
        'https://exemple.fr/robots.txt': {
          body: 'User-agent: *\nSITEMAP:  https://exemple.fr/s.xml',
        },
      });
      await expect(t.service.detect('https://exemple.fr/')).resolves.toBe(
        'https://exemple.fr/s.xml',
      );
    });

    it('essaie les emplacements conventionnels à défaut', async () => {
      const t = build({ 'https://exemple.fr/sitemap.xml': { status: 200 } });
      await expect(t.service.detect('https://exemple.fr/')).resolves.toBe(
        'https://exemple.fr/sitemap.xml',
      );
    });

    it('rend null quand aucun sitemap n’existe', async () => {
      // L'absence de sitemap est un cas NOMINAL, pas une erreur à propager.
      const t = build({});
      await expect(t.service.detect('https://exemple.fr/')).resolves.toBeNull();
    });

    it('rend null sur une URL illisible', async () => {
      const t = build({});
      await expect(t.service.detect('pas une url')).resolves.toBeNull();
      expect(t.safeFetch).not.toHaveBeenCalled();
    });

    it('PASSE par la politique SSRF pour chaque essai', async () => {
      const t = build({});
      await t.service.detect('https://exemple.fr/');
      expect(t.safeFetch).toHaveBeenCalled();
    });
  });

  describe('parse', () => {
    it('extrait les URL et leurs métadonnées', async () => {
      const t = build({ 'https://exemple.fr/s.xml': { body: SITEMAP_XML } });
      const result = await t.service.parse('https://exemple.fr/s.xml', {
        limit: 20,
        filterByPriority: false,
      });

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        url: 'https://exemple.fr/',
        lastmod: '2026-06-01',
        priority: 1,
      });
      expect(result.entries[1]).toMatchObject({ lastmod: null, priority: null });
    });

    it('DIT combien d’URL ont été découvertes avant troncature', async () => {
      // Sans ce chiffre, l'utilisateur croit que son sitemap ne contient que
      // `limit` URL.
      const t = build({ 'https://exemple.fr/s.xml': { body: SITEMAP_XML } });
      const result = await t.service.parse('https://exemple.fr/s.xml', {
        limit: 1,
        filterByPriority: false,
      });

      expect(result.discovered).toBe(2);
      expect(result.entries).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it('filtre sur la priorité quand c’est demandé', async () => {
      const t = build({ 'https://exemple.fr/s.xml': { body: SITEMAP_XML } });
      const result = await t.service.parse('https://exemple.fr/s.xml', {
        limit: 20,
        filterByPriority: true,
      });
      expect(result.entries).toHaveLength(1);
    });

    it('SUIT un sitemap d’index jusqu’à ses enfants', async () => {
      const t = build({
        'https://exemple.fr/index.xml': { body: INDEX_XML },
        'https://exemple.fr/sitemap-1.xml': { body: SITEMAP_XML },
      });
      const result = await t.service.parse('https://exemple.fr/index.xml', {
        limit: 20,
        filterByPriority: false,
      });
      expect(result.entries).toHaveLength(2);
    });

    it('BORNE la profondeur d’exploration d’un index', async () => {
      // Un index qui se référence lui-même — accident fréquent — ferait
      // autrement boucler la découverte indéfiniment.
      const selfReferencing = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://exemple.fr/boucle.xml</loc></sitemap>
</sitemapindex>`;
      const t = build({ 'https://exemple.fr/boucle.xml': { body: selfReferencing } });

      const result = await t.service.parse('https://exemple.fr/boucle.xml', {
        limit: 20,
        filterByPriority: false,
      });
      expect(result.entries).toEqual([]);
      // Trois lectures au plus : l'appel initial, puis deux niveaux d'index.
      expect(t.safeFetch.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('rend une liste vide quand le sitemap est injoignable', async () => {
      const t = build({});
      const result = await t.service.parse('https://exemple.fr/s.xml', {
        limit: 20,
        filterByPriority: false,
      });
      expect(result.entries).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it('LIBÈRE la connexion même en cas de réponse inexploitable', async () => {
      // Sans `dispose`, la connexion reste retenue hors du pool keep-alive.
      const t = build({ 'https://exemple.fr/s.xml': { status: 404 } });
      await t.service.parse('https://exemple.fr/s.xml', { limit: 20, filterByPriority: false });
      expect(t.dispose).toHaveBeenCalled();
    });
  });
});
