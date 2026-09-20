import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { LinksAnalyzer } from './links.analyzer.js';

const analyzer = new LinksAnalyzer();
const settings = makeSettings();

function page(body: string, url = 'https://exemple.fr/accueil') {
  return makePage(`<html><body>${body}</body></html>`, { url });
}

describe('LinksAnalyzer', () => {
  it('compte les liens internes et externes', async () => {
    const result = await analyzer.analyze(
      page('<a href="/a">A</a><a href="https://ailleurs.fr/" rel="nofollow">B</a>'),
      settings,
    );

    expect(result.items.find(item => item.key === 'LINKS.internal')?.label).toContain('1');
    expect(result.items.find(item => item.key === 'LINKS.external')?.label).toContain('1');
    expect(result.status).toBe('pass');
  });

  it('AVERTIT sur un lien externe sans nofollow', async () => {
    const result = await analyzer.analyze(page('<a href="https://ailleurs.fr/">B</a>'), settings);

    expect(result.items.some(item => item.key === 'LINKS.external_nofollow')).toBe(true);
    expect(result.status).toBe('warning');
  });

  it('AVERTIT quand la page n’a aucun lien HTTP', async () => {
    const result = await analyzer.analyze(page('<p>Rien</p>'), settings);

    expect(result.items.some(item => item.key === 'LINKS.no_http')).toBe(true);
  });

  describe('liens d’appel et de courriel', () => {
    it('ÉCHOUE sur un numéro invalide', async () => {
      const result = await analyzer.analyze(page('<a href="tel:12">Appeler</a>'), settings);

      expect(result.status).toBe('fail');
      expect(result.items.some(item => item.key === 'LINKS.ctc_invalid')).toBe(true);
    });

    it('accepte un numéro international, comme le critère CTA', async () => {
      // Les deux critères lisent le même numéro : des règles divergentes
      // feraient dire au rapport une chose et son contraire.
      const result = await analyzer.analyze(
        page('<a href="tel:+3221234567">Appeler</a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LINKS.ctc_invalid')).toBe(false);
    });

    it('lit le numéro d’un widget d’appel', async () => {
      const result = await analyzer.analyze(
        page('<a data-element-type="clicktocall" phone="12">Appeler</a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LINKS.ctc_invalid')).toBe(true);
    });

    it('ÉCHOUE sur une adresse invalide', async () => {
      const result = await analyzer.analyze(
        page('<a href="mailto:pas-une-adresse">Écrire</a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LINKS.ctm_invalid')).toBe(true);
    });
  });

  describe('liens auto-référentiels', () => {
    it('ÉCHOUE sur un lien de contenu vers la page courante', async () => {
      const result = await analyzer.analyze(
        page('<main><a href="/accueil">Accueil</a></main>'),
        settings,
      );

      expect(result.status).toBe('fail');
      expect(result.items.some(item => item.key === 'LINKS.self_reference')).toBe(true);
    });

    it('TOLÈRE le même lien dans le menu', async () => {
      // Un menu met légitimement en évidence la page active.
      const result = await analyzer.analyze(
        page('<nav><a href="/accueil">Accueil</a></nav>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LINKS.self_reference')).toBe(false);
    });

    it('TOLÈRE une ancre vers une section de la même page', async () => {
      const result = await analyzer.analyze(
        page('<main><a href="/accueil#contact">Nous contacter</a></main>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LINKS.self_reference')).toBe(false);
    });
  });

  it('SIGNALE une ancre sans destination', async () => {
    const result = await analyzer.analyze(page('<main><a>Texte orphelin</a></main>'), settings);

    expect(result.items.some(item => item.key === 'LINKS.empty_anchors')).toBe(true);
    const evidence = result.items.find(
      item => item.key === 'LINKS.empty_anchors' && item.status === 'info',
    );
    expect(evidence?.locator).toEqual({ text: 'Texte orphelin' });
  });

  describe('maillage de contenu', () => {
    it('retient les liens de contenu, pas ceux du menu', async () => {
      const result = await analyzer.analyze(
        page('<nav><a href="/menu">Menu</a></nav><main><a href="/article">Article</a></main>'),
        settings,
      );

      expect(result.contentLinks).toEqual(['https://exemple.fr/article']);
    });

    it.each([
      ['balise nav', '<nav>', '</nav>'],
      ['balise header', '<header>', '</header>'],
      ['balise footer', '<footer>', '</footer>'],
      ['rôle banner', '<div role="banner">', '</div>'],
      ['rôle contentinfo', '<div role="contentinfo">', '</div>'],
      ['classe dmNav', '<div class="dmNav">', '</div>'],
      ['classe dmRespNav', '<div class="p_dmRespNav">', '</div>'],
      ['classe dmHeader', '<div class="dmHeaderX">', '</div>'],
      ['classe dmFooter', '<div class="dmFooterX">', '</div>'],
      ['classe dmfooter minuscule', '<div class="x-dmfooter">', '</div>'],
      ['classe hfcontainer', '<div class="p_hfcontainer">', '</div>'],
      ['classe u_nav', '<div class="u_nav">', '</div>'],
      ['classe u_header', '<div class="u_header">', '</div>'],
      ['classe u_footer', '<div class="u_footer">', '</div>'],
      ['classe slimNav', '<div class="slimNav">', '</div>'],
      ['classe StickyNav', '<div class="StickyNav">', '</div>'],
      ['identifiant hcontainer', '<div id="hcontainer">', '</div>'],
      ['identifiant flex-header', '<div id="flex-header">', '</div>'],
      ['data-ux, casse indifférente', '<div data-ux="MenuNAVbar">', '</div>'],
      ['aria-label breadcrumb, casse indifférente', '<div aria-label="Fil BREADCRUMB">', '</div>'],
    ])(
      'ne compte pas comme contenu un lien dans un conteneur à %s',
      async (_nom, ouvrant, fermant) => {
        // Ces règles étaient un sélecteur de vingt clauses, recompilé pour chaque
        // lien interne de la page ; elles se lisent désormais sur les attributs.
        const result = await analyzer.analyze(
          page(
            `${ouvrant}<a href="/rubrique">Rubrique</a>${fermant}<main><a href="/article">Article</a></main>`,
          ),
          settings,
        );

        expect(result.contentLinks).toEqual(['https://exemple.fr/article']);
      },
    );

    it('compte comme contenu un lien dont le conteneur ne porte aucun signal', async () => {
      const result = await analyzer.analyze(
        page('<div class="colonne"><a href="/rubrique">Rubrique</a></div>'),
        settings,
      );

      expect(result.contentLinks).toEqual(['https://exemple.fr/rubrique']);
    });

    it('écarte les liens de boutique', async () => {
      const result = await analyzer.analyze(
        page('<main><div class="ec-store"><a href="/produit">Produit</a></div></main>'),
        settings,
      );

      expect(result.contentLinks).toEqual([]);
    });

    it('normalise les cibles avant de les retenir', async () => {
      const result = await analyzer.analyze(
        page('<main><a href="/article/">Un</a><a href="/article#bas">Deux</a></main>'),
        settings,
      );

      expect(result.contentLinks).toEqual(['https://exemple.fr/article']);
    });

    it('repère les liens d’un bloc légal', async () => {
      const result = await analyzer.analyze(
        page('<main><div data-title="Mentions Legales Footer"><a href="/ml">ML</a></div></main>'),
        settings,
      );

      expect(result.legalLinks).toEqual(['https://exemple.fr/ml']);
    });
  });

  describe('liens de pied de page exclusifs', () => {
    it('retient une page absente du menu principal', async () => {
      const result = await analyzer.analyze(
        page(
          '<header><nav><a href="/accueil">Accueil</a></nav></header><footer><a href="/lyon">Lyon</a><a href="/paris">Paris</a><a href="/nice">Nice</a></footer>',
        ),
        settings,
      );

      expect(result.footerLinks).toEqual([
        'https://exemple.fr/lyon',
        'https://exemple.fr/paris',
        'https://exemple.fr/nice',
      ]);
    });

    it('ÉCARTE un pied de page qui n’est qu’un écho du menu', async () => {
      // Un pied de page qui reprend le menu n'est pas un maillage délibéré :
      // le prendre pour tel ferait croire à une stratégie qui n'existe pas.
      const result = await analyzer.analyze(
        page(
          '<header><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav></header><footer><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a></footer>',
        ),
        settings,
      );

      expect(result.footerLinks).toEqual([]);
    });

    it('n’y compte pas les liens d’un bloc légal', async () => {
      const result = await analyzer.analyze(
        page(
          '<footer><div data-title="Mentions Légales"><a href="/ml">Mentions</a></div><a href="/lyon">Lyon</a></footer>',
        ),
        settings,
      );

      expect(result.footerLinks).toEqual(['https://exemple.fr/lyon']);
    });

    it('fait autorité à la navigation DÉCLARÉE par l’éditeur', async () => {
      // Un menu rendu en JavaScript échappe à la détection par le DOM : sans
      // cette source, ses pages passeraient pour des liens de pied de page
      // exclusifs.
      const navItems = Buffer.from(
        JSON.stringify([{ title: 'Lyon', path: '/lyon', inNavigation: true, subNav: [] }]),
      ).toString('base64');

      const result = await analyzer.analyze(
        page(
          `<script>window.Parameters={NavItems:'${navItems}',NavbarLiveHomePage:'https://exemple.fr/'};</script><footer><a href="/lyon">Lyon</a><a href="/paris">Paris</a></footer>`,
        ),
        settings,
      );

      expect(result.footerLinks).toEqual(['https://exemple.fr/paris']);
    });
  });

  describe('conteneurs cliquables', () => {
    it('les collecte À PART du maillage de contenu', async () => {
      // Une navigation en JavaScript ne transmet aucun signal aux moteurs :
      // la compter dans le maillage ferait croire qu'une page est liée alors
      // qu'elle reste invisible pour eux.
      const result = await analyzer.analyze(
        page('<main><div data-link-on-container="/bloc">Bloc</div></main>'),
        settings,
      );

      expect(result.containerLinks).toEqual([
        { url: 'https://exemple.fr/bloc', type: 'container', zone: 'content', anchor: 'Bloc' },
      ]);
      expect(result.contentLinks).toEqual([]);
    });

    it('ignore un conteneur pointant vers un autre domaine', async () => {
      const result = await analyzer.analyze(
        page('<div data-link-on-container="https://ailleurs.fr/x">Bloc</div>'),
        settings,
      );

      expect(result.containerLinks).toEqual([]);
    });
  });

  describe('exclusion de domaines', () => {
    it('écarte un domaine exclu par le profil', async () => {
      const result = await analyzer.analyze(
        page('<a href="https://mappy.com/carte">Carte</a>'),
        makeSettings({ links: { timeout: 5000, excludedDomains: ['mappy.com'] } }),
      );

      expect(result.items.find(item => item.key === 'LINKS.external')?.label).toContain('0');
    });

    it('n’exclut PAS un domaine qui contient seulement le texte exclu', async () => {
      // La v1 comparait par sous-chaîne d'URL : un auteur de page pouvait
      // faire ignorer n'importe quel lien en glissant le domaine exclu dans
      // ses paramètres.
      const result = await analyzer.analyze(
        page('<a href="https://faux-mappy.com.exemple.net/x">Piège</a>'),
        makeSettings({ links: { timeout: 5000, excludedDomains: ['mappy.com'] } }),
      );

      expect(result.items.find(item => item.key === 'LINKS.external')?.label).toContain('1');
    });
  });

  it('dresse la carte des liens avec zone et type', async () => {
    const result = await analyzer.analyze(
      page('<footer><a href="/a" class="btn">Cliquez ici</a></footer>'),
      settings,
    );

    expect(result.linkMap).toEqual([
      {
        href: 'https://exemple.fr/a',
        anchor: 'Cliquez ici',
        zone: 'footer',
        type: 'button',
        isInternal: true,
        isGenericAnchor: true,
        rel: undefined,
        targetIsAnchor: false,
      },
    ]);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      page('<a href="/a">A</a>'),
      makeSettings({ disabledChecks: ['LINKS'] }),
    );

    expect(result.status).toBe('na');
  });
});
