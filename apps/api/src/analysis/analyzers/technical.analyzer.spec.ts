import { describe, expect, it } from 'vitest';
import { CanonicalAnalyzer } from './canonical.analyzer.js';
import { ContentLengthAnalyzer, countVisibleWords } from './content-length.analyzer.js';
import { LangAnalyzer } from './lang.analyzer.js';
import { OpenGraphAnalyzer } from './opengraph.analyzer.js';
import { RedirectsAnalyzer } from './redirects.analyzer.js';
import { makePage, makeSettings } from '../testing/page.factory.js';

describe('CanonicalAnalyzer', () => {
  const analyzer = new CanonicalAnalyzer();
  const withCanonical = (href: string, url = 'https://exemple.fr/') =>
    makePage(`<html><head><link rel="canonical" href="${href}"></head><body></body></html>`, {
      url,
    });

  it('valide une canonical conforme', async () => {
    const result = await analyzer.analyze(withCanonical('https://exemple.fr/'), makeSettings());
    expect(result.status).toBe('pass');
  });

  it('sanctionne une canonical absente', async () => {
    const result = await analyzer.analyze(makePage('<p>x</p>'), makeSettings());
    expect(result.status).toBe('fail');
  });

  it('sanctionne des canonicals multiples', async () => {
    // Plusieurs canonicals se neutralisent : le moteur les ignore et choisit seul.
    const page = makePage(
      '<html><head><link rel="canonical" href="https://exemple.fr/a"><link rel="canonical" href="https://exemple.fr/b"></head><body></body></html>',
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.multiple')).toBe(true);
  });

  it('sanctionne une canonical sans href', async () => {
    const page = makePage('<html><head><link rel="canonical" href=""></head><body></body></html>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.no_href')).toBe(true);
  });

  it('ACCEPTE une canonical relative', async () => {
    // Une canonical relative est valide et résolue par le moteur : la déclarer
    // invalide — ce que faisait la v1 — est un faux positif.
    const result = await analyzer.analyze(withCanonical('/accueil'), makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.invalid_url')).toBe(false);
  });

  it('avertit sur une canonical inter-domaines', async () => {
    const result = await analyzer.analyze(withCanonical('https://autre.fr/'), makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.cross_domain')).toBe(true);
  });

  it('avertit sur une canonical portant des paramètres', async () => {
    const result = await analyzer.analyze(
      withCanonical('https://exemple.fr/?ref=a'),
      makeSettings(),
    );
    expect(result.items.some(item => item.key === 'CANONICAL.query_fragment')).toBe(true);
  });

  it('avertit sur une canonical en HTTP depuis une page HTTPS', async () => {
    const result = await analyzer.analyze(withCanonical('http://exemple.fr/'), makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.http')).toBe(true);
  });

  it('n’avertit PAS sur une canonical HTTP depuis une page HTTP', async () => {
    const page = withCanonical('http://exemple.fr/', 'http://exemple.fr/');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'CANONICAL.http')).toBe(false);
  });
});

describe('LangAnalyzer', () => {
  const analyzer = new LangAnalyzer();

  it('valide un lang courant', async () => {
    const page = makePage('<html lang="fr"><body></body></html>');
    expect((await analyzer.analyze(page, makeSettings())).status).toBe('pass');
  });

  it('sanctionne un lang absent', async () => {
    const page = makePage('<html><body></body></html>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'LANG.missing')).toBe(true);
  });

  it('avertit sur un code inhabituel', async () => {
    const page = makePage('<html lang="francais"><body></body></html>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'LANG.unusual')).toBe(true);
  });

  it('accepte une variante régionale non listée via sa base', async () => {
    // « fr-lu » n'est pas dans la liste, mais « fr » l'est : la liste sert à
    // repérer l'aberration, pas à valider BCP 47.
    const page = makePage('<html lang="fr-lu"><body></body></html>');
    expect((await analyzer.analyze(page, makeSettings())).status).toBe('pass');
  });

  it('signale une incohérence avec Content-Language', async () => {
    const page = makePage(
      '<html lang="fr"><head><meta http-equiv="Content-Language" content="de"></head><body></body></html>',
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'LANG.lang_mismatch')).toBe(true);
  });

  it('avertit sur un hreflang sans x-default', async () => {
    const page = makePage(
      '<html lang="fr"><head><link rel="alternate" hreflang="en" href="https://exemple.fr/en"></head><body></body></html>',
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'LANG.hreflang_no_default')).toBe(true);
  });

  it('accepte un hreflang complet', async () => {
    const page = makePage(
      '<html lang="fr"><head><link rel="alternate" hreflang="en" href="/en"><link rel="alternate" hreflang="x-default" href="/"></head><body></body></html>',
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'LANG.hreflang_no_default')).toBe(false);
  });
});

describe('ContentLengthAnalyzer', () => {
  const analyzer = new ContentLengthAnalyzer();
  const words = (count: number) => Array.from({ length: count }, () => 'mot').join(' ');

  it('sanctionne un contenu trop court', async () => {
    const result = await analyzer.analyze(makePage(`<p>${words(10)}</p>`), makeSettings());
    expect(result.status).toBe('fail');
  });

  it('avertit sur un contenu court', async () => {
    const settings = makeSettings({
      content: { ...makeSettings().content, minWords: 10, warningWords: 100 },
    });
    const result = await analyzer.analyze(makePage(`<p>${words(50)}</p>`), settings);
    expect(result.status).toBe('warning');
  });

  it('valide un contenu suffisant', async () => {
    const settings = makeSettings({
      content: { ...makeSettings().content, minWords: 10, warningWords: 20 },
    });
    const result = await analyzer.analyze(makePage(`<p>${words(50)}</p>`), settings);
    expect(result.status).toBe('pass');
  });
});

describe('countVisibleWords', () => {
  it('compte les mots du contenu visible', () => {
    expect(countVisibleWords(makePage('<p>un deux trois</p>'))).toBe(3);
  });

  it('EXCLUT scripts et styles', () => {
    // Un site chargé de scripts afficherait sinon des milliers de « mots »
    // dont aucun n'est lisible par un humain.
    const page = makePage(
      '<script>var a = 1; var b = 2;</script><style>.a{color:red}</style><p>un deux</p>',
    );
    expect(countVisibleWords(page)).toBe(2);
  });

  it('n’AMPUTE PAS le document lu ensuite par les autres analyseurs', () => {
    // Les analyseurs partagent la même instance Cheerio : retirer les scripts
    // pour de bon fausserait tous ceux qui les inspectent.
    const page = makePage('<script>var a = 1;</script><p>un deux</p>');
    countVisibleWords(page);
    expect(page.$('script')).toHaveLength(1);
  });

  it('rend zéro sur une page vide', () => {
    expect(countVisibleWords(makePage('<body></body>'))).toBe(0);
  });
});

describe('OpenGraphAnalyzer', () => {
  const analyzer = new OpenGraphAnalyzer();

  it('avertit sur des propriétés manquantes', async () => {
    const result = await analyzer.analyze(makePage('<p>x</p>'), makeSettings());
    expect(result.status).toBe('warning');
    expect(result.items.some(item => item.key === 'OG.missing')).toBe(true);
  });

  it('valide un jeu complet', async () => {
    const page = makePage(
      '<html><head>' +
        '<meta property="og:title" content="T">' +
        '<meta property="og:description" content="D">' +
        '<meta property="og:image" content="https://exemple.fr/i.jpg">' +
        '<meta property="og:url" content="https://exemple.fr/">' +
        '</head><body></body></html>',
    );
    expect((await analyzer.analyze(page, makeSettings())).status).toBe('pass');
  });

  it('traite la Twitter Card comme FACULTATIVE', async () => {
    // La plupart des réseaux retombent sur Open Graph : la compter comme un
    // défaut pénaliserait des sites parfaitement partageables.
    const page = makePage(
      '<html><head>' +
        '<meta property="og:title" content="T">' +
        '<meta property="og:description" content="D">' +
        '<meta property="og:image" content="https://exemple.fr/i.jpg">' +
        '<meta property="og:url" content="https://exemple.fr/">' +
        '</head><body></body></html>',
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.find(item => item.key === 'OG.twitter_missing')?.status).toBe('info');
    expect(result.status).toBe('pass');
  });
});

describe('RedirectsAnalyzer', () => {
  const analyzer = new RedirectsAnalyzer();

  it('valide un accès direct', async () => {
    const result = await analyzer.analyze(makePage('<p>x</p>'), makeSettings());
    expect(result.status).toBe('pass');
  });

  it('tolère une redirection unique', async () => {
    const page = makePage('<p>x</p>', {
      redirectChain: [{ url: 'http://exemple.fr/', status: 301 }],
    });
    expect((await analyzer.analyze(page, makeSettings())).status).toBe('pass');
  });

  it('avertit sur une chaîne longue', async () => {
    const page = makePage('<p>x</p>', {
      redirectChain: [
        { url: 'http://exemple.fr/', status: 301 },
        { url: 'https://exemple.fr/', status: 301 },
      ],
    });
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'REDIRECTS.chain_long')).toBe(true);
  });

  it('SIGNALE une redirection temporaire', async () => {
    // Une 302 dit « temporaire » : le moteur conserve alors l'ancienne URL dans
    // son index — l'inverse de l'effet recherché sur une migration.
    const page = makePage('<p>x</p>', {
      redirectChain: [{ url: 'http://exemple.fr/', status: 302 }],
    });
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'REDIRECTS.temporary')).toBe(true);
  });
});
