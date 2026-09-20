import { describe, expect, it, vi } from 'vitest';
import type { NetworkProbe, ProbeResult } from '../network-probe.js';
import { asProbe } from '../testing/probe.factory.js';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { RobotsMetaAnalyzer } from './robots-meta.analyzer.js';

const analyzer = new RobotsMetaAnalyzer();
const settings = makeSettings();

/** Sonde simulée — les analyseurs ne sortent jamais sur le réseau en test. */
function probe(over: Partial<ProbeResult> = {}): NetworkProbe {
  const result: ProbeResult = {
    url: 'https://exemple.fr/robots.txt',
    status: 200,
    ok: true,
    redirected: false,
    finalUrl: 'https://exemple.fr/robots.txt',
    contentLength: null,
    contentType: 'text/plain',
    ...over,
  };
  return asProbe({
    check: vi.fn().mockResolvedValue(result),
    checkMany: vi.fn().mockResolvedValue([result]),
    fetchText: vi.fn().mockResolvedValue({ result, body: '' }),
    remaining: 10,
  });
}

function page(inner: string, url = 'https://exemple.fr/') {
  return makePage(`<html><head>${inner}</head><body></body></html>`, { url });
}

describe('RobotsMetaAnalyzer', () => {
  it('N’AVERTIT PAS quand le robots.txt n’a pas été interrogé faute de quota', async () => {
    // Un quota atteint ne dit rien du site : l'annoncer en avertissement
    // ferait baisser la note pour une limite qui est la nôtre.
    const result = await analyzer.analyze(
      page(''),
      settings,
      probe({ status: null, ok: false, exhausted: true, error: 'Quota…' }),
    );

    const notice = result.items.find(item => item.label.includes('quota'));
    expect(notice?.status).toBe('info');
    expect(notice?.key).toBeUndefined();
    expect(result.items.some(item => item.key === 'ROBOTS.robots_txt_error')).toBe(false);
  });

  it('valide une page sans directive — index/follow par défaut', async () => {
    const result = await analyzer.analyze(page(''), settings, probe());

    expect(result.status).toBe('pass');
    expect(result.items[0]?.key).toBe('ROBOTS.no_directive');
  });

  it('ÉCHOUE sur un noindex, le défaut le plus coûteux de ce critère', async () => {
    const result = await analyzer.analyze(
      page('<meta name="robots" content="noindex, follow">'),
      settings,
      probe(),
    );

    expect(result.status).toBe('fail');
    expect(result.globalScore).toBe(0);
  });

  it('TOLÈRE le noindex d’une page de pré-publication', async () => {
    const result = await analyzer.analyze(
      page('<meta name="robots" content="noindex">', 'https://exemple.fr/?preview=1'),
      settings,
      probe(),
    );

    expect(result.items.find(item => item.key === 'ROBOTS.noindex')?.status).toBe('info');
    expect(result.status).not.toBe('fail');
  });

  it('lit les directives par JETON, pas par inclusion de chaîne', async () => {
    // « index » est contenu dans « noindex » : une comparaison par inclusion
    // confondrait les deux, et une directive `index` déclencherait l'alerte
    // réservée à son contraire.
    const result = await analyzer.analyze(
      page('<meta name="robots" content="index, follow">'),
      settings,
      probe(),
    );

    expect(result.items.some(item => item.key === 'ROBOTS.noindex')).toBe(false);
    expect(result.status).toBe('pass');
  });

  it('prend en compte l’en-tête X-Robots-Tag', async () => {
    const target = makePage('<html><head></head><body></body></html>', {
      headers: { 'x-robots-tag': 'noindex' },
    });

    const result = await analyzer.analyze(target, settings, probe());

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'ROBOTS.x_robots_tag')).toBe(true);
  });

  it('ne compte le noindex qu’UNE FOIS quand il est déclaré deux fois', async () => {
    // Le même fait énoncé dans la balise ET dans l'en-tête reste un seul
    // défaut : le pénaliser deux fois exagérerait sa gravité.
    const target = makePage('<html><head><meta name="robots" content="noindex"></head></html>', {
      headers: { 'x-robots-tag': 'noindex' },
    });

    const result = await analyzer.analyze(target, settings, probe());

    expect(result.items.filter(item => item.status === 'fail')).toHaveLength(1);
  });

  it('AVERTIT sur nofollow et noarchive', async () => {
    const result = await analyzer.analyze(
      page('<meta name="robots" content="nofollow, noarchive">'),
      settings,
      probe(),
    );

    expect(result.status).toBe('warning');
    expect(result.globalScore).toBe(3);
  });

  describe('robots.txt', () => {
    it('constate sa présence', async () => {
      const result = await analyzer.analyze(page(''), settings, probe({ status: 200 }));

      expect(result.items.some(item => item.key === 'ROBOTS.robots_txt_ok')).toBe(true);
    });

    it('AVERTIT quand il est introuvable', async () => {
      const result = await analyzer.analyze(page(''), settings, probe({ status: 404, ok: false }));

      expect(result.items.some(item => item.key === 'ROBOTS.robots_txt_missing')).toBe(true);
      expect(result.status).toBe('warning');
    });

    it('DIT qu’il n’a pas vérifié plutôt que de conclure', async () => {
      // Sans sortie réseau, annoncer un robots.txt sain serait une affirmation
      // sans preuve — pire qu'un silence.
      const result = await analyzer.analyze(page(''), settings, undefined);

      const item = result.items.find(item => item.key === 'ROBOTS.robots_txt_error');
      expect(item?.status).toBe('info');
      expect(result.status).toBe('pass');
    });

    it('AVERTIT quand la vérification échoue', async () => {
      const result = await analyzer.analyze(
        page(''),
        settings,
        probe({ status: null, ok: false, error: 'Hôte injoignable' }),
      );

      expect(result.items.some(item => item.key === 'ROBOTS.robots_txt_error')).toBe(true);
      expect(result.status).toBe('warning');
    });

    it('rapporte un statut inattendu tel quel', async () => {
      const result = await analyzer.analyze(page(''), settings, probe({ status: 500, ok: false }));

      expect(result.items.some(item => item.key === 'ROBOTS.robots_txt_status')).toBe(true);
    });

    it('interroge la RACINE du site, pas le chemin courant', async () => {
      const net = probe();
      await analyzer.analyze(page('', 'https://exemple.fr/blog/article'), settings, net);

      expect(net.check).toHaveBeenCalledWith('https://exemple.fr/robots.txt');
    });
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      page(''),
      makeSettings({ disabledChecks: ['ROBOTS_META'] }),
      probe(),
    );

    expect(result.status).toBe('na');
  });
});
