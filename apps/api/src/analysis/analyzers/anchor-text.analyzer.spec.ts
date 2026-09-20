import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { AnchorTextAnalyzer } from './anchor-text.analyzer.js';

const analyzer = new AnchorTextAnalyzer();
const settings = makeSettings();

function page(body: string, url = 'https://exemple.fr/accueil') {
  return makePage(`<html><body><main>${body}</main></body></html>`, { url });
}

/** Niveau attribué au premier lien de la page. */
function levelOf(items: { key?: string }[]): string | undefined {
  return items
    .map(item => item.key)
    .find(key => key?.startsWith('ANCHOR_TEXT.') && key !== 'ANCHOR_TEXT.summary');
}

describe('AnchorTextAnalyzer', () => {
  it('ne signale rien quand la page n’a aucun lien de contenu', async () => {
    const result = await analyzer.analyze(page('<p>Texte seul</p>'), settings);

    expect(result.status).toBe('pass');
    expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
  });

  it('reconnaît une ancre qui annonce sa destination', async () => {
    const result = await analyzer.analyze(
      page('<a href="/nos-services-plomberie">Nos services de plomberie</a>'),
      settings,
    );

    expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    expect(result.status).toBe('pass');
  });

  it('ÉCHOUE sur une ancre qui annonce autre chose', async () => {
    const result = await analyzer.analyze(
      page('<a href="/recrutement-apprentissage">Nos chantiers de toiture</a>'),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'ANCHOR_TEXT.discordant')).toBe(true);
  });

  describe('ancres génériques', () => {
    it('SIGNALE « cliquez ici »', async () => {
      const result = await analyzer.analyze(
        page('<a href="/nos-services">Cliquez ici</a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'ANCHOR_TEXT.generic')).toBe(true);
      expect(result.status).toBe('warning');
    });

    it('SIGNALE une ancre faite de mots-outils', async () => {
      const result = await analyzer.analyze(page('<a href="/services">Pour les</a>'), settings);

      expect(result.items.some(item => item.key === 'ANCHOR_TEXT.generic')).toBe(true);
    });
  });

  it('déclare AMBIGU un chemin sans segment textuel', async () => {
    // « /123 » ne dit rien : conclure à la discordance accuserait à tort.
    const result = await analyzer.analyze(
      page('<a href="/123">Nos réalisations récentes</a>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'ANCHOR_TEXT.ambiguous')).toBe(true);
  });

  describe('pré-classement par intention', () => {
    it('accepte une ADRESSE liée à la page de contact', async () => {
      // Les mots « rue » et « Lyon » ne figurent pas dans le segment
      // « contact » : sans ce court-circuit, le rappel serait nul et l'adresse
      // rapportée discordante.
      const result = await analyzer.analyze(
        page('<a href="/contact">12 rue de la Paix, 69002 Lyon</a>'),
        settings,
      );

      expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    });

    it('accepte un NUMÉRO lié à la page de contact', async () => {
      const result = await analyzer.analyze(
        page('<a href="/nous-contacter">04 72 00 00 00</a>'),
        settings,
      );

      expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    });

    it('accepte une ADRESSE ÉLECTRONIQUE liée à la page de contact', async () => {
      const result = await analyzer.analyze(
        page('<a href="/coordonnees">contact@exemple.fr</a>'),
        settings,
      );

      expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    });

    it('n’accepte PAS une adresse liée à une page quelconque', async () => {
      const result = await analyzer.analyze(
        page('<a href="/nos-tarifs">12 rue de la Paix, 69002 Lyon</a>'),
        settings,
      );

      expect(levelOf(result.items)).not.toBe('ANCHOR_TEXT.concordant');
    });
  });

  describe('lien de marque', () => {
    const withCompany = makeSettings({
      anchorText: { companyName: 'Boulangerie Durand SARL' },
    });

    it('accepte la raison sociale vers une page éditoriale', async () => {
      // Un nom propre n'apparaît pas dans l'URL : le calcul le noterait zéro.
      const result = await analyzer.analyze(
        page('<a href="/notre-histoire">Boulangerie Durand</a>'),
        withCompany,
      );

      expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    });

    it('REFUSE la raison sociale vers une page commerciale', async () => {
      // Une ancre de marque vers une page produit doit décrire ce produit.
      const result = await analyzer.analyze(
        page('<a href="/boutique">Boulangerie Durand</a>'),
        withCompany,
      );

      expect(levelOf(result.items)).not.toBe('ANCHOR_TEXT.concordant');
    });

    it('n’accepte un match PARTIEL que vers une page « à propos »', async () => {
      const about = await analyzer.analyze(page('<a href="/a-propos">Durand</a>'), withCompany);
      const elsewhere = await analyzer.analyze(
        page('<a href="/nos-tarifs-2024">Durand</a>'),
        withCompany,
      );

      expect(levelOf(about.items)).toBe('ANCHOR_TEXT.concordant');
      expect(levelOf(elsewhere.items)).not.toBe('ANCHOR_TEXT.concordant');
    });
  });

  describe('zones et exclusions', () => {
    it('IGNORE par défaut les liens de navigation', async () => {
      // Un menu porte des libellés courts par nature : les juger sur la
      // concordance ferait échouer tous les sites.
      const result = await analyzer.analyze(
        makePage(
          '<html><body><nav><a href="/nos-services-plomberie">Accueil</a></nav></body></html>',
        ),
        settings,
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });

    describe('reconnaissance des zones', () => {
      /** Lien de contenu, placé dans le conteneur à éprouver. */
      const inside = (container: string, closing: string) =>
        makePage(
          `<html><body>${container}<a href="/nos-services-plomberie">Nos services de plomberie</a>${closing}</body></html>`,
        );

      it.each([
        ['balise nav', '<nav>', '</nav>'],
        ['rôle navigation', '<div role="navigation">', '</div>'],
        ['classe nav', '<div class="nav">', '</div>'],
        ['classe menu', '<div class="menu">', '</div>'],
        ['classe dmNav', '<div class="dmNav">', '</div>'],
        ['type d’élément menu', '<div data-element-type="menu">', '</div>'],
        ['balise header', '<header>', '</header>'],
        ['rôle banner', '<div role="banner">', '</div>'],
        ['classe header', '<div class="header">', '</div>'],
        ['classe dmHeaderContainer', '<div class="dmHeaderContainer">', '</div>'],
        ['classe flex_hfcontainer', '<div class="flex_hfcontainer">', '</div>'],
        ['balise footer', '<footer>', '</footer>'],
        ['rôle contentinfo', '<div role="contentinfo">', '</div>'],
        ['classe footer', '<div class="footer">', '</div>'],
        ['classe dmFooterContainer', '<div class="dmFooterContainer">', '</div>'],
      ])('ignore un lien placé dans un conteneur à %s', async (_nom, ouvrant, fermant) => {
        const result = await analyzer.analyze(inside(ouvrant, fermant), settings);

        expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
      });

      it('juge un lien dont le conteneur ne porte aucun signal', async () => {
        const result = await analyzer.analyze(
          inside('<div class="quelconque">', '</div>'),
          settings,
        );

        expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
      });

      it('ne prend PAS une classe approchante pour un signal', async () => {
        // `.nav` est un jeton de classe entier : `navigateur` n'en est pas un.
        const result = await analyzer.analyze(
          inside('<div class="navigateur">', '</div>'),
          settings,
        );

        expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
      });

      it('fait primer le MENU même quand le pied de page est PLUS PROCHE', async () => {
        // Les trois familles étaient éprouvées l'une après l'autre sur toute la
        // chaîne d'ascendance : le menu l'emporte donc sur un signal de pied de
        // page plus proche du lien. C'est le piège de la traduction, un
        // parcours unique rendrait sinon le signal le plus proche.
        const piedDansMenu = makePage(
          '<html><body><div class="dmNav"><div class="footer"><a href="/nos-services-plomberie">Nos services de plomberie</a></div></div></body></html>',
        );

        const ignoreMenu = await analyzer.analyze(
          piedDansMenu,
          makeSettings({ anchorText: { ignoreZones: ['nav'] } }),
        );
        const ignorePied = await analyzer.analyze(
          piedDansMenu,
          makeSettings({ anchorText: { ignoreZones: ['footer'] } }),
        );

        expect(ignoreMenu.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
        expect(levelOf(ignorePied.items)).toBe('ANCHOR_TEXT.concordant');
      });

      it('fait primer l’EN-TÊTE sur un pied de page plus proche', async () => {
        const piedDansEntete = makePage(
          '<html><body><header><div class="footer"><a href="/nos-services-plomberie">Nos services de plomberie</a></div></header></body></html>',
        );

        const ignoreEntete = await analyzer.analyze(
          piedDansEntete,
          makeSettings({ anchorText: { ignoreZones: ['header'] } }),
        );
        const ignorePied = await analyzer.analyze(
          piedDansEntete,
          makeSettings({ anchorText: { ignoreZones: ['footer'] } }),
        );

        expect(ignoreEntete.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
        expect(levelOf(ignorePied.items)).toBe('ANCHOR_TEXT.concordant');
      });

      it('fait primer le MENU sur le pied de page, quelle que soit la distance', async () => {
        // Les trois familles étaient testées l'une après l'autre sur toute la
        // chaîne d'ascendance : le menu l'emporte donc même s'il est plus
        // lointain que le pied de page.
        const dansPiedDeMenu = makePage(
          '<html><body><footer><nav><a href="/nos-services-plomberie">Nos services de plomberie</a></nav></footer></body></html>',
        );

        const ignoreMenu = await analyzer.analyze(
          dansPiedDeMenu,
          makeSettings({ anchorText: { ignoreZones: ['nav'] } }),
        );
        const ignorePied = await analyzer.analyze(
          dansPiedDeMenu,
          makeSettings({ anchorText: { ignoreZones: ['footer'] } }),
        );

        expect(ignoreMenu.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
        expect(levelOf(ignorePied.items)).toBe('ANCHOR_TEXT.concordant');
      });
    });

    it('exclut aussi un lien dont un ANCÊTRE est visé par le sélecteur', async () => {
      // Le sélecteur du profil désigne un bloc entier, pas seulement le lien.
      const result = await analyzer.analyze(
        page(
          '<div class="bandeau"><span><a href="/recrutement">Nos chantiers de toiture</a></span></div>',
        ),
        makeSettings({ anchorText: { excludeSelectors: ['.bandeau'] } }),
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });

    it('honore un sélecteur d’exclusion du profil', async () => {
      const result = await analyzer.analyze(
        page('<a href="/recrutement-apprentissage" class="logo">Nos chantiers de toiture</a>'),
        makeSettings({ anchorText: { excludeSelectors: ['.logo'] } }),
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });

    it('ne se laisse pas casser par un sélecteur invalide', async () => {
      const result = await analyzer.analyze(
        page('<a href="/nos-services-plomberie">Nos services de plomberie</a>'),
        makeSettings({ anchorText: { excludeSelectors: ['::(('] } }),
      );

      expect(levelOf(result.items)).toBe('ANCHOR_TEXT.concordant');
    });

    it('écarte les liens de boutique quand le profil le demande', async () => {
      const result = await analyzer.analyze(
        makePage(
          '<html><body><script>window.Parameters={StorePath:\'/boutique\'};</script><main><a href="/boutique/pain-complet">Nos chantiers de toiture</a></main></body></html>',
          { url: 'https://exemple.fr/accueil' },
        ),
        makeSettings({ anchorText: { excludeShopLinks: true } }),
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });

    it('IGNORE les liens externes', async () => {
      const result = await analyzer.analyze(
        page('<a href="https://ailleurs.fr/recrutement">Nos chantiers de toiture</a>'),
        settings,
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });

    it('IGNORE une ancre vers une section de la même page', async () => {
      const result = await analyzer.analyze(
        page('<a href="/accueil#chantiers">Nos chantiers de toiture</a>'),
        settings,
      );

      expect(result.items[0]?.key).toBe('ANCHOR_TEXT.no_links');
    });
  });

  it('se tait quand le profil désactive l’analyse', async () => {
    const result = await analyzer.analyze(
      page('<a href="/recrutement-apprentissage">Nos chantiers de toiture</a>'),
      makeSettings({ anchorText: { enabled: false } }),
    );

    expect(result.status).toBe('na');
  });

  it('BORNE le nombre de liens rapportés', async () => {
    const links = Array.from(
      { length: 8 },
      (_, index) => `<a href="/recrutement-apprentissage-${index}">Nos chantiers de toiture</a>`,
    ).join('');

    const result = await analyzer.analyze(
      page(links),
      makeSettings({ anchorText: { maxLinksReported: 3 } }),
    );

    expect(result.items.filter(item => item.key === 'ANCHOR_TEXT.discordant')).toHaveLength(3);
  });

  it('montre AUSSI pourquoi un lien concorde', async () => {
    const result = await analyzer.analyze(
      page('<a href="/nos-services-plomberie">Nos services de plomberie</a>'),
      settings,
    );

    const item = result.items.find(entry => entry.key === 'ANCHOR_TEXT.concordant');
    expect(item?.status).toBe('info');
    expect(item?.detail).toContain('segments');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      page('<a href="/a">A</a>'),
      makeSettings({ disabledChecks: ['ANCHOR_TEXT'] }),
    );

    expect(result.status).toBe('na');
  });
});
