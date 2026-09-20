import * as cheerio from 'cheerio';
import type { LinkZone } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import {
  detectLinkZone,
  isButtonLink,
  isInFooterZone,
  isInLegalTitledContainer,
  isInShopZone,
} from './link-zone.js';
import type { Selection } from './page.model.js';

/**
 * Sélecteurs d'ORIGINE, conservés ici et nulle part ailleurs.
 *
 * La reconnaissance de zone se faisait par ces sélecteurs, reparsés à chaque
 * appel. Le module les remplace par des tests d'attributs ; ils restent dans ce
 * test comme implémentation de référence, pour prouver cas par cas que la
 * traduction n'a rien changé.
 */
const SELECTORS = {
  shop: '.ec-store, [class*="ec-store"], [class*="ecwid"]',
  footer:
    'footer, [role="contentinfo"], [class*="dmFooter"], [class*="dmfooter"], [class*="u_footer"], [class*="u_fcontainer"], [class*="f_hcontainer"], [id*="dmFooter"], #fcontainer',
  nav: 'nav, [class*="dmNav"], [class*="dmRespNav"], [class*="u_nav"]',
  header:
    'header, [role="banner"], [class*="dmHeader"], [class*="u_header"], [class*="u_hcontainer"], [class*="hfcontainer"], [id*="dmHeader"], #hcontainer, #flex-header',
  sidebar: 'aside, [class*="sidebar"]',
  hero: '[class*="hero"], [class*="banner"], [class*="slider"]',
  cta: '[class*="btn"], [class*="button"], [class*="cta"], [class*="dm-cta"], [class*="dmButton"], [class*="u_btn"]',
  content: 'main, [role="main"], .dmContent, #dmContentContainer',
} as const;

/** Zone d'un lien telle que la calculait l'implémentation par sélecteurs. */
function referenceZone(node: Selection): LinkZone {
  const parents = node.parents();
  for (let index = 0; index < parents.length; index += 1) {
    const ancestor = parents.eq(index);
    for (const [zone, selector] of Object.entries(SELECTORS)) {
      if (ancestor.is(selector)) return zone as LinkZone;
    }
  }
  return node.is(SELECTORS.cta) ? 'cta' : 'content';
}

/** Lien seul dans un conteneur porteur des attributs donnés. */
function linkIn(attributes: string, wrapper = 'div'): Selection {
  const $ = cheerio.load(
    `<body><${wrapper} ${attributes}><a href="/x">Lien</a></${wrapper}></body>`,
  );
  return $('a');
}

/**
 * Conteneurs représentatifs : un par règle, plus les pièges documentés.
 *
 * Chaque entrée est jouée deux fois — par les prédicats et par les sélecteurs
 * d'origine — et les deux verdicts doivent coïncider.
 */
const CASES: ReadonlyArray<{ description: string; attributes: string; wrapper?: string }> = [
  { description: 'balise footer', attributes: '', wrapper: 'footer' },
  { description: 'balise nav', attributes: '', wrapper: 'nav' },
  { description: 'balise header', attributes: '', wrapper: 'header' },
  { description: 'balise aside', attributes: '', wrapper: 'aside' },
  { description: 'balise main', attributes: '', wrapper: 'main' },
  { description: 'rôle contentinfo', attributes: 'role="contentinfo"' },
  { description: 'rôle banner', attributes: 'role="banner"' },
  { description: 'rôle main', attributes: 'role="main"' },
  { description: 'classe dmFooter', attributes: 'class="dmFooter"' },
  { description: 'classe dmfooter minuscule', attributes: 'class="p_dmfooter_zone"' },
  { description: 'classe u_fcontainer', attributes: 'class="x u_fcontainer y"' },
  { description: 'classe f_hcontainer', attributes: 'class="f_hcontainer"' },
  { description: 'identifiant contenant dmFooter', attributes: 'id="zone-dmFooter-1"' },
  { description: 'identifiant fcontainer exact', attributes: 'id="fcontainer"' },
  { description: 'identifiant hcontainer exact', attributes: 'id="hcontainer"' },
  { description: 'identifiant flex-header exact', attributes: 'id="flex-header"' },
  { description: 'identifiant contenant dmHeader', attributes: 'id="x-dmHeader"' },
  { description: 'classe dmNav', attributes: 'class="dmNav"' },
  { description: 'classe dmRespNav', attributes: 'class="dmRespNav dmNavItem"' },
  { description: 'classe u_nav', attributes: 'class="u_nav"' },
  { description: 'classe u_header', attributes: 'class="u_header"' },
  { description: 'classe hfcontainer partagée', attributes: 'class="p_hfcontainer"' },
  { description: 'classe sidebar', attributes: 'class="page-sidebar"' },
  { description: 'classe hero', attributes: 'class="hero-banner"' },
  { description: 'classe slider', attributes: 'class="slider-wrap"' },
  { description: 'classe btn', attributes: 'class="btn btn-primary"' },
  { description: 'classe dmButton', attributes: 'class="dmButton"' },
  { description: 'classe u_btn', attributes: 'class="u_btn"' },
  { description: 'classe dm-cta', attributes: 'class="dm-cta"' },
  { description: 'classe ec-store', attributes: 'class="ec-store"' },
  { description: 'classe ecwid', attributes: 'class="ecwid-shop"' },
  { description: 'jeton dmContent exact', attributes: 'class="dmContent"' },
  { description: 'dmContentSlot, qui n’est PAS le contenu', attributes: 'class="dmContentSlot"' },
  { description: 'identifiant dmContentContainer', attributes: 'id="dmContentContainer"' },
  { description: 'aucun signal', attributes: 'class="quelconque"' },
  { description: 'identifiant fcontainer approchant', attributes: 'id="fcontainer-2"' },
];

describe('zone d’un lien', () => {
  describe('équivalence avec les sélecteurs d’origine', () => {
    it.each(CASES)('$description', ({ attributes, wrapper }) => {
      const node = linkIn(attributes, wrapper);

      expect(detectLinkZone(node)).toBe(referenceZone(node));
    });
  });

  describe('règles de classement', () => {
    it('retient l’ancêtre le PLUS PROCHE', () => {
      // Laisser l'ancêtre le plus externe gagner classerait en pied de page la
      // moitié d'une page dont le pied enveloppe une navigation secondaire.
      const $ = cheerio.load('<footer><nav class="dmNav"><a href="/x">Lien</a></nav></footer>');

      expect(detectLinkZone($('a'))).toBe('nav');
    });

    it('tranche le conteneur PARTAGÉ en faveur du pied de page', () => {
      // L'éditeur donne `p_hfcontainer` à l'en-tête ET au pied : tester
      // l'en-tête d'abord classerait tout le pied de page en en-tête.
      const $ = cheerio.load('<div class="p_hfcontainer u_footer"><a href="/x">Lien</a></div>');

      expect(detectLinkZone($('a'))).toBe('footer');
    });

    it('un dmContentSlot dans le pied de page reste du PIED DE PAGE', () => {
      // C'est tout l'enjeu du jeton EXACT : l'éditeur place des `dmContentSlot`
      // et des `dmContentBox` DANS l'en-tête et le pied. Les prendre pour le
      // contenu principal masquerait le conteneur qui les porte.
      const $ = cheerio.load(
        '<footer><div class="dmContentSlot"><a href="/x">Lien</a></div></footer>',
      );

      expect(detectLinkZone($('a'))).toBe('footer');
      expect(referenceZone($('a'))).toBe('footer');
    });

    it('classe en CONTENU un lien sans aucun signal', () => {
      expect(detectLinkZone(linkIn('class="quelconque"'))).toBe('content');
    });

    it('classe en CTA un lien qui est lui-même un bouton', () => {
      const $ = cheerio.load('<div><a class="btn" href="/x">Lien</a></div>');

      expect(detectLinkZone($('a'))).toBe('cta');
    });

    it('rend « contenu » pour une sélection vide', () => {
      expect(detectLinkZone(cheerio.load('<body></body>')('a'))).toBe('content');
    });
  });

  describe('appartenance à une zone', () => {
    it('voit le pied de page à travers une navigation secondaire', () => {
      // `detectLinkZone` rend « menu » ici : la question du pied de page se
      // pose donc séparément.
      const $ = cheerio.load('<footer><nav class="dmNav"><a href="/x">Lien</a></nav></footer>');

      expect(detectLinkZone($('a'))).toBe('nav');
      expect(isInFooterZone($('a'))).toBe(true);
    });

    it('reconnaît un lien de boutique par son conteneur', () => {
      const $ = cheerio.load('<div class="ec-store"><span><a href="/p">Produit</a></span></div>');

      expect(isInShopZone($('a'))).toBe(true);
    });

    it('ne voit pas de boutique là où il n’y en a pas', () => {
      expect(isInShopZone(linkIn('class="contenu"'))).toBe(false);
    });

    it('reconnaît un bloc légal par son data-title', () => {
      const $ = cheerio.load('<div data-title="Mentions légales"><a href="/ml">Mentions</a></div>');

      expect(isInLegalTitledContainer($('a'))).toBe(true);
    });

    it('ignore un data-title sans rapport', () => {
      const $ = cheerio.load('<div data-title="Nos services"><a href="/s">Services</a></div>');

      expect(isInLegalTitledContainer($('a'))).toBe(false);
    });

    it('reconnaît un lien POSÉ dans un bouton', () => {
      const $ = cheerio.load('<div class="btn"><a href="/x">Lien</a></div>');

      expect(isButtonLink($('a'))).toBe(true);
    });

    it('et un lien QUI EST le bouton', () => {
      const $ = cheerio.load('<div><a class="cta" href="/x">Lien</a></div>');

      expect(isButtonLink($('a'))).toBe(true);
    });

    it('rend faux sur une sélection vide', () => {
      const empty = cheerio.load('<body></body>')('a');

      expect(isButtonLink(empty)).toBe(false);
      expect(isInFooterZone(empty)).toBe(false);
      expect(isInShopZone(empty)).toBe(false);
      expect(isInLegalTitledContainer(empty)).toBe(false);
    });
  });
});
