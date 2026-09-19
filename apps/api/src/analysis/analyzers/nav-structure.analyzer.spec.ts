import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { NavStructureAnalyzer } from './nav-structure.analyzer.js';

const analyzer = new NavStructureAnalyzer();
const settings = makeSettings();

/** Les trois pages essentielles, dans une seule navigation. */
const COMPLETE = `
  <a href="/">Accueil</a>
  <a href="/a-propos">À propos</a>
  <a href="/realisations">Nos réalisations</a>`;

function navPage(inner: string, url = 'https://exemple.fr/') {
  return makePage(`<html><body><div id="hcontainer">${inner}</div></body></html>`, { url });
}

function nav(links: string, attributes = '') {
  return `<nav role="navigation"${attributes}>${links}</nav>`;
}

describe('NavStructureAnalyzer', () => {
  describe('applicabilité', () => {
    it('se déclare NON APPLICABLE hors des gabarits concernés', async () => {
      // Le critère vérifie une convention de construction, pas une règle
      // universelle : inventer un défaut ailleurs serait faux.
      const result = await analyzer.analyze(
        makePage('<nav><a href="/">Accueil</a></nav>'),
        settings,
      );

      expect(result.status).toBe('na');
    });

    it('se déclare NON APPLICABLE sans nav de navigation', async () => {
      const result = await analyzer.analyze(navPage('<div>Pas de nav</div>'), settings);

      expect(result.status).toBe('na');
    });
  });

  it('valide une navigation complète', async () => {
    const result = await analyzer.analyze(navPage(nav(COMPLETE)), settings);

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('reconnaît les pages par leur CHEMIN autant que par leur libellé', async () => {
    const result = await analyzer.analyze(
      navPage(nav('<a href="/">x</a><a href="/about">y</a><a href="/portfolio">z</a>')),
      settings,
    );

    expect(result.status).toBe('pass');
  });

  it('AVERTIT quand une page essentielle manque', async () => {
    const result = await analyzer.analyze(
      navPage(nav('<a href="/">Accueil</a><a href="/a-propos">À propos</a>')),
      settings,
    );

    expect(result.status).toBe('warning');
    expect(result.globalScore).toBe(3);
  });

  it('ÉCHOUE quand aucune page essentielle n’est présente', async () => {
    const result = await analyzer.analyze(navPage(nav('<a href="/blog">Blog</a>')), settings);

    expect(result.status).toBe('fail');
    expect(result.globalScore).toBe(0);
  });

  it('N’ANNONCE JAMAIS un échec d’item sous un verdict d’avertissement', async () => {
    // La v1 marquait le premier manque en avertissement et les suivants en
    // échec, alors que le verdict global se calcule sur le nombre de pages
    // présentes : un critère pouvait s'afficher « avertissement » tout en
    // contenant un item rouge.
    const result = await analyzer.analyze(
      navPage(nav('<a href="/">Accueil</a><a href="/blog">Blog</a>')),
      settings,
    );

    expect(result.status).toBe('warning');
    expect(result.items.some(item => item.status === 'fail')).toBe(false);
  });

  describe('menus mobiles', () => {
    it('IGNORE un menu burger masqué', async () => {
      const result = await analyzer.analyze(
        navPage(nav(COMPLETE) + nav('<a href="/x">x</a>', ' class="dmRespMenu"')),
        settings,
      );

      expect(result.status).toBe('pass');
      expect(result.items.some(item => item.key === 'NAV_STRUCTURE.nav_hidden_2')).toBe(true);
    });

    it('reconnaît un masquage par style en ligne', async () => {
      const result = await analyzer.analyze(
        navPage(nav(COMPLETE) + nav('<a href="/x">x</a>', ' style="display: none"')),
        settings,
      );

      expect(result.items.some(item => item.key === 'NAV_STRUCTURE.nav_hidden_2')).toBe(true);
    });

    it('reconnaît un masquage porté par un CONTENEUR', async () => {
      // Duda masque le menu mobile sur un conteneur, jamais sur la balise nav.
      const result = await analyzer.analyze(
        navPage(
          `${nav(COMPLETE)}<div class="mobile-menu"><div>${nav('<a href="/x">x</a>')}</div></div>`,
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'NAV_STRUCTURE.nav_hidden_2')).toBe(true);
    });

    it('ÉCHOUE si TOUTES les navigations sont masquées', async () => {
      const result = await analyzer.analyze(
        navPage(nav(COMPLETE, ' aria-hidden="true"')),
        settings,
      );

      expect(result.status).toBe('fail');
      expect(result.items.some(item => item.key === 'NAV_STRUCTURE.all_hidden')).toBe(true);
    });
  });

  describe('navigations multiples', () => {
    it('retient la PREMIÈRE navigation visible comme principale', async () => {
      const result = await analyzer.analyze(
        navPage(nav('<a href="/services">Services</a>') + nav(COMPLETE)),
        settings,
      );

      expect(
        result.items.find(item => item.key === 'NAV_STRUCTURE.primary_selection')?.label,
      ).toContain('nav[1]');
    });

    it('cherche les pages essentielles dans TOUTES les navigations visibles', async () => {
      // Une organisation courante met les pages métier dans la navigation
      // principale et les génériques dans la secondaire : ne lire que la
      // première pénaliserait un site correctement construit.
      const result = await analyzer.analyze(
        navPage(nav('<a href="/services">Services</a>') + nav(COMPLETE)),
        settings,
      );

      expect(result.status).toBe('pass');
    });
  });

  it('ÉCHOUE quand la navigation principale n’a aucun lien', async () => {
    const result = await analyzer.analyze(navPage(nav('<span>Menu</span>')), settings);

    expect(result.items.some(item => item.key === 'NAV_STRUCTURE.no_links')).toBe(true);
    expect(result.status).toBe('fail');
  });

  it('ignore les ancres mortes', async () => {
    const result = await analyzer.analyze(navPage(nav('<a href="#">Rien</a>')), settings);

    expect(result.items.some(item => item.key === 'NAV_STRUCTURE.no_links')).toBe(true);
  });

  it('reconnaît la racine d’un site en aperçu', async () => {
    const result = await analyzer.analyze(
      navPage(
        '<nav role="navigation"><a href="/site/abc123def/">Accueil</a><a href="/a-propos">À propos</a><a href="/portfolio">Réalisations</a></nav>',
        'https://exemple.fr/site/abc123def/contact',
      ),
      settings,
    );

    expect(result.status).toBe('pass');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      navPage(nav(COMPLETE)),
      makeSettings({ disabledChecks: ['NAV_STRUCTURE'] }),
    );

    expect(result.status).toBe('na');
  });
});
