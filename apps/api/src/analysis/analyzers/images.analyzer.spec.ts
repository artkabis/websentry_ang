import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from '../network-probe.js';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { ImagesAnalyzer } from './images.analyzer.js';

const analyzer = new ImagesAnalyzer();
const settings = makeSettings();

/** Sonde qui rend, pour chaque URL, le poids et le type demandés. */
function probe(byUrl: Record<string, { size?: number; type?: string }> = {}) {
  const describe = (url: string): ProbeResult => {
    const entry = byUrl[url] ?? {};
    return {
      url,
      status: 200,
      ok: true,
      redirected: false,
      finalUrl: url,
      contentLength: entry.size ?? 10_000,
      contentType: entry.type ?? 'image/webp',
    };
  };

  return {
    check: vi.fn(url => Promise.resolve(describe(url))),
    checkMany: vi.fn((urls: readonly string[]) => Promise.resolve(urls.map(describe))),
    fetchText: vi.fn(),
    remaining: 500,
  };
}

describe('ImagesAnalyzer', () => {
  it('se déclare NON APPLICABLE sans image', async () => {
    const result = await analyzer.analyze(makePage('<p>Texte</p>'), settings, probe());

    expect(result.status).toBe('na');
  });

  it('valide des images légères, modernes et décrites', async () => {
    const result = await analyzer.analyze(
      makePage('<img src="/a.webp" alt="Une image">'),
      settings,
      probe(),
    );

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  describe('texte alternatif', () => {
    it('ÉCHOUE sur une image sans attribut alt', async () => {
      const result = await analyzer.analyze(makePage('<img src="/a.webp">'), settings, probe());

      expect(result.items.some(item => item.key === 'IMAGES.alt_missing')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('compte à part les images décoratives', async () => {
      const result = await analyzer.analyze(
        makePage('<img src="/a.webp" alt=""><img src="/b.webp" alt="Vue">'),
        settings,
        probe(),
      );

      expect(result.items.find(item => item.key === 'IMAGES.decorative')?.label).toContain('1');
    });
  });

  describe('poids', () => {
    it('ÉCHOUE au-delà du plafond', async () => {
      const result = await analyzer.analyze(
        makePage('<img src="/gros.webp" alt="x">'),
        settings,
        probe({ 'https://exemple.fr/gros.webp': { size: 5_000_000 } }),
      );

      expect(result.items.some(item => item.key === 'IMAGES.weight_fail')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('AVERTIT entre les deux seuils', async () => {
      const result = await analyzer.analyze(
        makePage('<img src="/moyen.webp" alt="x">'),
        settings,
        probe({ 'https://exemple.fr/moyen.webp': { size: 300_000 } }),
      );

      expect(result.items.some(item => item.key === 'IMAGES.weight_warn')).toBe(true);
    });

    it('DIT qu’il n’a rien mesuré sans sortie réseau', async () => {
      // Annoncer « poids correct » sans avoir pesé serait une affirmation sans
      // mesure.
      const result = await analyzer.analyze(
        makePage('<img src="/a.webp" alt="x">'),
        settings,
        undefined,
      );

      expect(result.items.some(item => item.key === 'IMAGES.weight_ok')).toBe(false);
      expect(result.items.some(item => item.label.includes('non mesuré'))).toBe(true);
    });

    it('ne pèse chaque URL qu’une fois', async () => {
      const net = probe();
      await analyzer.analyze(
        makePage('<img src="/a.webp" alt="1"><img src="/a.webp" alt="2">'),
        settings,
        net,
      );

      expect(net.checkMany).toHaveBeenCalledWith(['https://exemple.fr/a.webp']);
    });
  });

  describe('format', () => {
    it('AVERTIT sur un format hérité', async () => {
      const result = await analyzer.analyze(
        makePage('<img src="/photo.jpg" alt="x">'),
        settings,
        probe({ 'https://exemple.fr/photo.jpg': { type: 'image/jpeg' } }),
      );

      expect(result.items.some(item => item.key === 'IMAGES.format_modern')).toBe(true);
    });

    it('reconnaît le format par son TYPE MIME quand l’URL n’a pas d’extension', async () => {
      // Les CDN des éditeurs servent des URL sans extension : s'en tenir à
      // l'URL, comme la v1, laissait ces images hors du contrôle.
      const result = await analyzer.analyze(
        makePage('<img src="https://cdn.exemple.fr/i/abc123" alt="x">'),
        settings,
        probe({ 'https://cdn.exemple.fr/i/abc123': { type: 'image/png' } }),
      );

      expect(result.items.some(item => item.key === 'IMAGES.format_modern')).toBe(true);
    });

    it('accepte un SVG servi en image/svg+xml', async () => {
      const result = await analyzer.analyze(
        makePage('<img src="https://cdn.exemple.fr/logo" alt="x">'),
        settings,
        probe({ 'https://cdn.exemple.fr/logo': { type: 'image/svg+xml' } }),
      );

      expect(result.items.some(item => item.key === 'IMAGES.format_modern')).toBe(false);
    });
  });

  it('ignore une image encodée dans la page', async () => {
    // Une image `data:` n'a ni URL à peser ni format à convertir.
    const result = await analyzer.analyze(
      makePage('<img src="data:image/gif;base64,R0lGOD" alt="x">'),
      settings,
      probe(),
    );

    expect(result.status).toBe('na');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<img src="/a.webp" alt="x">'),
      makeSettings({ disabledChecks: ['IMAGES'] }),
      probe(),
    );

    expect(result.status).toBe('na');
  });
});
