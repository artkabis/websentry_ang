import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from '../network-probe.js';
import { asProbe } from '../testing/probe.factory.js';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { BrokenLinksAnalyzer } from './broken-links.analyzer.js';

const analyzer = new BrokenLinksAnalyzer();
const settings = makeSettings();

/** Sonde qui rend, par URL, le statut demandé — 200 par défaut. */
function probe(byUrl: Record<string, Partial<ProbeResult>> = {}) {
  const describe = (url: string): ProbeResult => ({
    url,
    status: 200,
    ok: true,
    redirected: false,
    finalUrl: url,
    contentLength: null,
    contentType: 'text/html',
    ...byUrl[url],
  });

  return asProbe({
    check: vi.fn(url => Promise.resolve(describe(url))),
    checkMany: vi.fn((urls: readonly string[]) => Promise.resolve(urls.map(describe))),
    fetchText: vi.fn(),
    remaining: 500,
  });
}

describe('BrokenLinksAnalyzer', () => {
  it('se déclare NON APPLICABLE sans lien HTTP', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="mailto:a@b.fr">Écrire</a><a href="#haut">Haut</a>'),
      settings,
      probe(),
    );

    expect(result.status).toBe('na');
  });

  it('N’AFFIRME RIEN sans sortie réseau', async () => {
    // Annoncer « aucun lien cassé » sans avoir vérifié serait une conclusion
    // sans preuve.
    const result = await analyzer.analyze(
      makePage('<a href="/page">Page</a>'),
      settings,
      undefined,
    );

    expect(result.status).toBe('na');
  });

  it('valide une page aux liens sains', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="/a">A</a><a href="/b">B</a>'),
      settings,
      probe(),
    );

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'BROKEN.no_broken')).toBe(true);
  });

  it('ÉCHOUE sur un 404, en nommant le lien', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="/absent">La page</a>'),
      settings,
      probe({ 'https://exemple.fr/absent': { status: 404, ok: false } }),
    );

    expect(result.status).toBe('fail');
    const broken = result.items.find(item => item.key === 'BROKEN.broken');
    expect(broken?.label).toContain('404');
    expect(broken?.locator).toEqual({ text: 'La page' });
  });

  describe('refus opposé aux robots', () => {
    it('NE COMPTE PAS un 403 comme un lien cassé', async () => {
      // Un pare-feu applicatif répond 403 à tout ce qui ressemble à un robot :
      // le rapport se remplirait de faux positifs incorrigeables.
      const result = await analyzer.analyze(
        makePage('<a href="https://ailleurs.fr/x">Lien</a>'),
        settings,
        probe({ 'https://ailleurs.fr/x': { status: 403, ok: false } }),
      );

      expect(result.status).toBe('pass');
      expect(result.items.some(item => item.key === 'BROKEN.rate_limited')).toBe(true);
    });

    it('tolère un 429 sur un réseau social', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="https://www.instagram.com/compte">Instagram</a>'),
        settings,
        probe({ 'https://www.instagram.com/compte': { status: 429, ok: false } }),
      );

      expect(result.items.some(item => item.key === 'BROKEN.rate_limited')).toBe(true);
    });

    it('mais SANCTIONNE un 429 hors de ces domaines', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="https://boutique.fr/x">Produit</a>'),
        settings,
        probe({ 'https://boutique.fr/x': { status: 429, ok: false } }),
      );

      expect(result.status).toBe('fail');
    });
  });

  describe('quota de requêtes atteint', () => {
    const quotaProbe = () =>
      probe({
        'https://exemple.fr/b': { status: null, ok: false, exhausted: true, error: 'Quota…' },
      });

    it('NE COMPTE PAS un lien non vérifié comme injoignable', async () => {
      // Le quota est une limite que nous nous imposons : la faire payer au site
      // audité, c'est lui reprocher notre propre plafond.
      const result = await analyzer.analyze(
        makePage('<a href="/a">A</a><a href="/b">B</a>'),
        settings,
        quotaProbe(),
      );

      expect(result.status).toBe('pass');
      expect(result.globalScore).toBe(5);
      expect(result.items.some(item => item.key === 'BROKEN.timeout')).toBe(false);
    });

    it('le DIT, plutôt que de le taire', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="/a">A</a><a href="/b">B</a>'),
        settings,
        quotaProbe(),
      );

      const notice = result.items.find(item => item.label.includes('quota'));
      expect(notice?.status).toBe('info');
      // Sans clé : ce n'est pas un point de contrôle, et cela ne doit pas
      // entrer dans le décompte des sous-critères.
      expect(notice?.key).toBeUndefined();
      expect(result.summary).toContain('non vérifié');
    });

    it('ne compte pas un lien non vérifié parmi les liens vérifiés', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="/a">A</a><a href="/b">B</a>'),
        settings,
        quotaProbe(),
      );

      expect(result.items.find(item => item.key === 'BROKEN.checked')?.value).toBe(1);
    });

    it('ne le donne pas non plus pour joignable au maillage', async () => {
      // `linkResolutions` alimente la carte du site : y faire entrer une URL
      // jamais interrogée ferait disparaître un futur 404.
      const result = await analyzer.analyze(
        makePage('<a href="/a">A</a><a href="/b">B</a>'),
        settings,
        quotaProbe(),
      );

      expect(result.linkResolutions?.map(entry => entry.url)).toEqual(['https://exemple.fr/a']);
    });
  });

  it('AVERTIT sur un lien injoignable', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="https://hors-ligne.fr/">Site</a>'),
      settings,
      probe({
        'https://hors-ligne.fr/': { status: null, ok: false, error: 'Délai dépassé' },
      }),
    );

    expect(result.status).toBe('warning');
    expect(result.items.some(item => item.key === 'BROKEN.timeout')).toBe(true);
  });

  it('EXPOSE une redirection sans la sanctionner', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="http://exemple.fr/a">A</a>'),
      settings,
      probe({
        'http://exemple.fr/a': { redirected: true, finalUrl: 'https://exemple.fr/a' },
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'BROKEN.redirected')).toBe(true);
  });

  describe('collecte', () => {
    it('suit un conteneur cliquable sans balise de lien', async () => {
      // Un bloc entier qui navigue au clic n'est pas un <a> : le rater
      // laisserait un lien cassé invisible au rapport.
      const result = await analyzer.analyze(
        makePage('<div data-link-on-container="/bloc">Bloc</div>'),
        settings,
        probe({ 'https://exemple.fr/bloc': { status: 404, ok: false } }),
      );

      expect(result.status).toBe('fail');
      expect(result.items.some(item => item.label.includes('conteneur'))).toBe(true);
    });

    it('écarte les domaines exclus par le profil', async () => {
      const net = probe();
      await analyzer.analyze(
        makePage('<a href="https://mappy.com/x">Carte</a><a href="/a">A</a>'),
        makeSettings({ links: { timeout: 5000, excludedDomains: ['mappy.com'] } }),
        net,
      );

      expect(net.checkMany).toHaveBeenCalledWith(['https://exemple.fr/a']);
    });

    it('écarte les schémas non vérifiables', async () => {
      const net = probe();
      await analyzer.analyze(
        makePage('<a href="javascript:void(0)">x</a><a href="/a">A</a>'),
        settings,
        net,
      );

      expect(net.checkMany).toHaveBeenCalledWith(['https://exemple.fr/a']);
    });

    it('ramène un lien d’aperçu sur l’environnement analysé', async () => {
      // L'éditeur génère des liens de boutique portant le domaine de
      // production alors que la page auditée est en aperçu : les vérifier tels
      // quels testerait un autre environnement.
      const net = probe();
      await analyzer.analyze(
        makePage('<a href="https://production.fr/site/abc12345def/boutique">Boutique</a>', {
          url: 'https://apercu.fr/site/abc12345def/accueil',
        }),
        settings,
        net,
      );

      expect(net.checkMany).toHaveBeenCalledWith(['https://apercu.fr/site/abc12345def/boutique']);
    });
  });

  it('dresse l’inventaire des liens valides par zone', async () => {
    const result = await analyzer.analyze(
      makePage('<footer><a href="/mentions">Mentions</a></footer>'),
      settings,
      probe(),
    );

    const inventory = result.items.find(item => item.key === 'BROKEN.link_valid');
    expect(inventory?.label).toContain('pied de page');
    expect(inventory?.status).toBe('info');
  });

  it('expose les résolutions pour le recoupement du maillage', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="http://exemple.fr/a">A</a>'),
      settings,
      probe({ 'http://exemple.fr/a': { redirected: true, finalUrl: 'https://exemple.fr/a' } }),
    );

    expect(result.linkResolutions).toEqual([
      {
        url: 'http://exemple.fr/a',
        finalUrl: 'https://exemple.fr/a',
        reachable: true,
        redirected: true,
      },
    ]);
  });

  it('ANNULE la note à partir de trois liens cassés', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>'),
      settings,
      probe({
        'https://exemple.fr/a': { status: 404, ok: false },
        'https://exemple.fr/b': { status: 500, ok: false },
        'https://exemple.fr/c': { status: 404, ok: false },
      }),
    );

    expect(result.globalScore).toBe(0);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<a href="/a">A</a>'),
      makeSettings({ disabledChecks: ['BROKEN_LINKS'] }),
      probe(),
    );

    expect(result.status).toBe('na');
  });
});
