import type { LinkZone } from '@websentry/shared';
import type { Selection } from './page.model.js';

/**
 * Zone d'un lien dans la page — fonctions PURES, partagées par LINKS et
 * BROKEN_LINKS.
 *
 * La zone change le sens d'un lien : un lien répété dans le pied de page est
 * normal, le même répété dans le contenu ne l'est pas. Un seul module la
 * décide, sans quoi deux critères classeraient le même lien différemment.
 */

/** Boutons et appels à l'action, par convention de classe. */
const CTA_SELECTOR =
  '[class*="btn"], [class*="button"], [class*="cta"], [class*="dm-cta"], [class*="dmButton"], [class*="u_btn"]';

const SHOP_SELECTOR = '.ec-store, [class*="ec-store"], [class*="ecwid"]';

/**
 * Le pied de page est testé AVANT l'en-tête.
 *
 * L'éditeur partage la classe `p_hfcontainer` entre les deux conteneurs :
 * tester l'en-tête d'abord classerait tout le pied de page en en-tête. On
 * tranche donc sur les signaux propres au pied de page.
 */
const FOOTER_SELECTOR =
  'footer, [role="contentinfo"], [class*="dmFooter"], [class*="dmfooter"], [class*="u_footer"], [class*="u_fcontainer"], [class*="f_hcontainer"], [id*="dmFooter"], #fcontainer';

const NAV_SELECTOR = 'nav, [class*="dmNav"], [class*="dmRespNav"], [class*="u_nav"]';

const HEADER_SELECTOR =
  'header, [role="banner"], [class*="dmHeader"], [class*="u_header"], [class*="u_hcontainer"], [class*="hfcontainer"], [id*="dmHeader"], #hcontainer, #flex-header';

const SIDEBAR_SELECTOR = 'aside, [class*="sidebar"]';
const HERO_SELECTOR = '[class*="hero"], [class*="banner"], [class*="slider"]';

/**
 * Contenu principal — jeton EXACT `.dmContent`.
 *
 * `[class*="dmContent"]` attraperait les `dmContentSlot` et `dmContentBox` que
 * l'éditeur place AUSSI dans l'en-tête et le pied de page.
 */
const CONTENT_SELECTOR = 'main, [role="main"], .dmContent, #dmContentContainer';

/** Conteneurs dont le `data-title` annonce un bloc légal. */
const LEGAL_TITLE_PATTERN =
  /mentions?\s*l[ée]gal|l[ée]gales|confidentialit|vie\s*priv|privacy|\brgpd\b|\bgdpr\b|\bcgv\b|\bcgu\b|cookies?|impressum/i;

/**
 * Mémoire par élément du document.
 *
 * La zone d'un ancêtre ne dépend pas du lien qui le traverse, et les liens
 * d'une page partagent massivement leurs ancêtres : le conteneur de navigation
 * est l'ancêtre des quarante liens du menu. Sans mémoire, il est réinterrogé
 * quarante fois, et chaque interrogation coûte huit sélecteurs d'attributs —
 * puis tout recommence pour le critère suivant, qui repart du même DOM.
 *
 * Les clés sont les nœuds du document analysé et les tables sont FAIBLES :
 * elles disparaissent avec lui, sans rien à purger.
 */
const zoneByElement = new WeakMap<object, LinkZone | null>();
const linkZoneByElement = new WeakMap<object, LinkZone>();
const footerByElement = new WeakMap<object, boolean>();

/** Libellé court d'une zone, pour l'affichage. */
export const ZONE_LABEL: Record<LinkZone, string> = {
  nav: 'menu',
  header: 'en-tête',
  footer: 'pied de page',
  hero: 'hero',
  content: 'contenu',
  sidebar: 'sidebar',
  cta: 'CTA',
  shop: 'boutique',
  unknown: '',
};

/**
 * Zone d'un lien, d'après ses ancêtres.
 *
 * L'ancêtre le plus PROCHE l'emporte : un lien de contenu imbriqué sous un
 * conteneur au signal « pied de page » plus lointain reste du contenu. Laisser
 * l'ancêtre le plus externe gagner classerait la moitié d'une page en pied de
 * page.
 */
export function detectLinkZone(node: Selection): LinkZone {
  const element = node.get(0);
  if (!element) return computeLinkZone(node);

  const known = linkZoneByElement.get(element);
  if (known) return known;

  const zone = computeLinkZone(node);
  linkZoneByElement.set(element, zone);
  return zone;
}

function computeLinkZone(node: Selection): LinkZone {
  const parents = node.parents();
  for (let index = 0; index < parents.length; index += 1) {
    const zone = zoneOf(parents.eq(index), parents.get(index));
    if (zone) return zone;
  }
  return node.is(CTA_SELECTOR) ? 'cta' : 'content';
}

function zoneOf(node: Selection, element: object | undefined): LinkZone | null {
  if (!element) return classify(node);

  const known = zoneByElement.get(element);
  // `undefined` = jamais classé ; `null` = classé « aucun signal ».
  if (known !== undefined) return known;

  const zone = classify(node);
  zoneByElement.set(element, zone);
  return zone;
}

function classify(node: Selection): LinkZone | null {
  if (node.is(SHOP_SELECTOR)) return 'shop';
  if (node.is(FOOTER_SELECTOR)) return 'footer';
  if (node.is(NAV_SELECTOR)) return 'nav';
  if (node.is(HEADER_SELECTOR)) return 'header';
  if (node.is(SIDEBAR_SELECTOR)) return 'sidebar';
  if (node.is(HERO_SELECTOR)) return 'hero';
  if (node.is(CTA_SELECTOR)) return 'cta';
  if (node.is(CONTENT_SELECTOR)) return 'content';
  return null;
}

/**
 * Le lien est-il dans le pied de page ?
 *
 * Distinct de `detectLinkZone`, qui rend l'ancêtre le plus proche : une
 * navigation SECONDAIRE placée dans le pied de page y est classée « menu », ce
 * qui masque le conteneur de pied de page plus lointain.
 */
export function isInFooterZone(node: Selection): boolean {
  const element = node.get(0);
  if (!element) return node.closest(FOOTER_SELECTOR).length > 0;

  const known = footerByElement.get(element);
  if (known !== undefined) return known;

  const inFooter = node.closest(FOOTER_SELECTOR).length > 0;
  footerByElement.set(element, inFooter);
  return inFooter;
}

/** Le lien est-il dans un conteneur dont le `data-title` annonce un bloc légal ? */
export function isInLegalTitledContainer(node: Selection): boolean {
  return node
    .parents('[data-title]')
    .toArray()
    .some(element => LEGAL_TITLE_PATTERN.test(element.attribs?.['data-title'] ?? ''));
}

export { CTA_SELECTOR };
