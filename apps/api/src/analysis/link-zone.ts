import type { LinkZone } from '@websentry/shared';
import {
  ancestorsOf,
  classIncludesAny,
  classTokensOf,
  firstElementOf,
  hasAncestorMatching,
} from './dom-walk.js';
import type { DomElement, Selection } from './page.model.js';

/**
 * Zone d'un lien dans la page — fonctions PURES, partagées par LINKS et
 * BROKEN_LINKS.
 *
 * La zone change le sens d'un lien : un lien répété dans le pied de page est
 * normal, le même répété dans le contenu ne l'est pas. Un seul module la
 * décide, sans quoi deux critères classeraient le même lien différemment.
 *
 * La reconnaissance se fait sur les ATTRIBUTS, pas par sélecteurs CSS. Un
 * `node.is('…')` reparse et recompile sa chaîne à chaque appel : sur une page
 * de deux cents liens, la lecture des zones passait un quart de son temps dans
 * l'analyseur de sélecteurs de Cheerio. Les règles reproduites ici sont
 * exactement celles des sélecteurs d'origine — un test différentiel les
 * compare, cas par cas, à une implémentation de référence qui les utilise.
 */

/** Boutons et appels à l'action, par convention de classe. */
const CTA_CLASSES = ['btn', 'button', 'cta', 'dm-cta', 'dmButton', 'u_btn'];

const SHOP_CLASSES = ['ec-store', 'ecwid'];

/**
 * Le pied de page est testé AVANT l'en-tête.
 *
 * L'éditeur partage la classe `p_hfcontainer` entre les deux conteneurs :
 * tester l'en-tête d'abord classerait tout le pied de page en en-tête. On
 * tranche donc sur les signaux propres au pied de page.
 */
const FOOTER_CLASSES = [
  'dmFooter',
  'dmfooter',
  'u_footer',
  'u_fcontainer',
  'f_hcontainer',
] as const;

const NAV_CLASSES = ['dmNav', 'dmRespNav', 'u_nav'];

const HEADER_CLASSES = ['dmHeader', 'u_header', 'u_hcontainer', 'hfcontainer'];

const SIDEBAR_CLASSES = ['sidebar'];
const HERO_CLASSES = ['hero', 'banner', 'slider'];

/** Conteneurs dont le `data-title` annonce un bloc légal. */
const LEGAL_TITLE_PATTERN =
  /mentions?\s*l[ée]gal|l[ée]gales|confidentialit|vie\s*priv|privacy|\brgpd\b|\bgdpr\b|\bcgv\b|\bcgu\b|cookies?|impressum/i;

/**
 * Mémoire par élément du document.
 *
 * La zone d'un ancêtre ne dépend pas du lien qui le traverse, et les liens
 * d'une page partagent massivement leurs ancêtres : le conteneur de navigation
 * est l'ancêtre des quarante liens du menu. Sans mémoire, il est réinterrogé
 * quarante fois — puis tout recommence pour le critère suivant, qui repart du
 * même DOM.
 *
 * Les clés sont les nœuds du document analysé et les tables sont FAIBLES :
 * elles disparaissent avec lui, sans rien à purger.
 */
const zoneByElement = new WeakMap<object, LinkZone | null>();
const linkZoneByElement = new WeakMap<object, LinkZone>();
const footerByElement = new WeakMap<object, boolean>();
const shopByElement = new WeakMap<object, boolean>();
const ctaByElement = new WeakMap<object, boolean>();

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

function isShop(element: DomElement): boolean {
  return classIncludesAny(element, SHOP_CLASSES);
}

function isFooter(element: DomElement): boolean {
  const id = element.attribs?.['id'] ?? '';
  return (
    element.name === 'footer' ||
    element.attribs?.['role'] === 'contentinfo' ||
    classIncludesAny(element, FOOTER_CLASSES) ||
    id.includes('dmFooter') ||
    id === 'fcontainer'
  );
}

function isNav(element: DomElement): boolean {
  return element.name === 'nav' || classIncludesAny(element, NAV_CLASSES);
}

function isHeader(element: DomElement): boolean {
  const id = element.attribs?.['id'] ?? '';
  return (
    element.name === 'header' ||
    element.attribs?.['role'] === 'banner' ||
    classIncludesAny(element, HEADER_CLASSES) ||
    id.includes('dmHeader') ||
    id === 'hcontainer' ||
    id === 'flex-header'
  );
}

function isSidebar(element: DomElement): boolean {
  return element.name === 'aside' || classIncludesAny(element, SIDEBAR_CLASSES);
}

function isHero(element: DomElement): boolean {
  return classIncludesAny(element, HERO_CLASSES);
}

function isCta(element: DomElement): boolean {
  return classIncludesAny(element, CTA_CLASSES);
}

/**
 * Contenu principal — jeton EXACT `dmContent`.
 *
 * Une sous-chaîne attraperait les `dmContentSlot` et `dmContentBox` que
 * l'éditeur place AUSSI dans l'en-tête et le pied de page.
 */
function isContent(element: DomElement): boolean {
  return (
    element.name === 'main' ||
    element.attribs?.['role'] === 'main' ||
    classTokensOf(element).includes('dmContent') ||
    element.attribs?.['id'] === 'dmContentContainer'
  );
}

function classify(element: DomElement): LinkZone | null {
  if (isShop(element)) return 'shop';
  if (isFooter(element)) return 'footer';
  if (isNav(element)) return 'nav';
  if (isHeader(element)) return 'header';
  if (isSidebar(element)) return 'sidebar';
  if (isHero(element)) return 'hero';
  if (isCta(element)) return 'cta';
  if (isContent(element)) return 'content';
  return null;
}

/** Zone d'un ancêtre, mémorisée : il est partagé par tous les liens qu'il porte. */
function zoneOfAncestor(element: DomElement): LinkZone | null {
  const known = zoneByElement.get(element);
  // `undefined` = jamais classé ; `null` = classé « aucun signal ».
  if (known !== undefined) return known;

  const zone = classify(element);
  zoneByElement.set(element, zone);
  return zone;
}

/**
 * Zone d'un lien, d'après ses ancêtres.
 *
 * L'ancêtre le plus PROCHE l'emporte : un lien de contenu imbriqué sous un
 * conteneur au signal « pied de page » plus lointain reste du contenu. Laisser
 * l'ancêtre le plus externe gagner classerait la moitié d'une page en pied de
 * page.
 */
export function detectLinkZone(node: Selection): LinkZone {
  const element = firstElementOf(node);
  if (!element) return 'content';

  const known = linkZoneByElement.get(element);
  if (known) return known;

  let zone: LinkZone = isCta(element) ? 'cta' : 'content';
  for (const ancestor of ancestorsOf(element)) {
    const found = zoneOfAncestor(ancestor);
    if (found) {
      zone = found;
      break;
    }
  }

  linkZoneByElement.set(element, zone);
  return zone;
}

/**
 * Le lien est-il dans le pied de page ?
 *
 * Distinct de `detectLinkZone`, qui rend l'ancêtre le plus proche : une
 * navigation SECONDAIRE placée dans le pied de page y est classée « menu », ce
 * qui masque le conteneur de pied de page plus lointain.
 */
export function isInFooterZone(node: Selection): boolean {
  return hasAncestorMatching(node, footerByElement, isFooter, { includeSelf: true });
}

/** Le lien est-il dans un conteneur de boutique ? */
export function isInShopZone(node: Selection): boolean {
  return hasAncestorMatching(node, shopByElement, isShop, { includeSelf: false });
}

/** Le lien est-il dans un conteneur dont le `data-title` annonce un bloc légal ? */
export function isInLegalTitledContainer(node: Selection): boolean {
  const element = firstElementOf(node);
  if (!element) return false;

  for (const ancestor of ancestorsOf(element)) {
    if (LEGAL_TITLE_PATTERN.test(ancestor.attribs?.['data-title'] ?? '')) return true;
  }
  return false;
}

/** Le lien EST-IL un bouton, ou est-il posé dans un bouton ? */
export function isButtonLink(node: Selection): boolean {
  return hasAncestorMatching(node, ctaByElement, isCta, { includeSelf: true });
}
