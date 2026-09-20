import type {
  CheckItem,
  CheckResult,
  ContentLinkDetail,
  LinkEntry,
  LinkType,
  LinkZone,
} from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import { extractDudaNavPages } from '../duda-nav.js';
import type { EffectiveSettings } from '../effective-settings.js';
import {
  detectLinkZone,
  isInFooterZone,
  isInLegalTitledContainer,
  isInShopZone,
} from '../link-zone.js';
import {
  classIncludesAny,
  firstElementOf,
  firstImageIn,
  hasAncestorMatching,
} from '../dom-walk.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { DomElement, HtmlPage, Selection } from '../page.model.js';

/**
 * Cartographie des liens.
 *
 * Le critère note la page, mais il produit surtout la MATIÈRE d'une analyse
 * inter-pages : maillage de contenu, liens de pied de page exclusifs, liens de
 * conteneur. Ces sorties annexes sont la raison d'être du critère autant que sa
 * note.
 */

/** Numéro de téléphone acceptable — aligné sur le critère CTA. */
const PHONE_NATIONAL = /^0[1-9]\d{8}$/;
const PHONE_E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ancres qui n'annoncent pas leur destination. */
const GENERIC_ANCHORS: ReadonlySet<string> = new Set([
  'cliquez ici',
  'en savoir plus',
  'ici',
  'voir plus',
  'lire la suite',
  'click here',
  'read more',
  'voir',
  'découvrir',
  'accéder',
  "plus d'infos",
  'en savoir +',
  'voir tout',
  'all',
  'more',
  'here',
]);

/** Zones de navigation — un lien y vers la page courante est légitime. */
const NAVIGATION_ZONES: ReadonlySet<LinkZone> = new Set(['nav', 'header', 'footer', 'sidebar']);

/**
 * Conteneurs de navigation, pour distinguer le maillage de contenu du reste.
 *
 * Lus sur les attributs, et non par un sélecteur : `parents('…')` recompilait
 * cette liste de vingt clauses pour CHAQUE lien interne de la page.
 */
const NAV_TAGS: ReadonlySet<string> = new Set(['nav', 'header', 'footer']);
const NAV_ROLES: ReadonlySet<string> = new Set(['banner', 'contentinfo']);
const NAV_CLASS_PARTS = [
  'dmNav',
  'dmRespNav',
  'dmHeader',
  'dmFooter',
  'dmfooter',
  'hfcontainer',
  'u_nav',
  'u_header',
  'u_footer',
  'slimNav',
  'StickyNav',
];
const NAV_IDS: ReadonlySet<string> = new Set(['hcontainer', 'flex-header']);

/** Mémoire par élément — un conteneur de navigation porte des dizaines de liens. */
const navigationByElement = new WeakMap<object, boolean>();

function isNavigationContainer(element: DomElement): boolean {
  const attribs = element.attribs ?? {};
  return (
    NAV_TAGS.has(element.name) ||
    NAV_ROLES.has(attribs['role'] ?? '') ||
    classIncludesAny(element, NAV_CLASS_PARTS) ||
    NAV_IDS.has(attribs['id'] ?? '') ||
    // Ces deux clauses étaient marquées `i` dans le sélecteur d'origine : la
    // comparaison reste donc insensible à la casse.
    (attribs['data-ux'] ?? '').toLowerCase().includes('nav') ||
    (attribs['aria-label'] ?? '').toLowerCase().includes('breadcrumb')
  );
}

function isInNavigationContainer(node: Selection): boolean {
  return hasAncestorMatching(node, navigationByElement, isNavigationContainer, {
    includeSelf: false,
  });
}

const BUTTON_CLASS_PARTS = ['btn', 'button', 'cta'];

/**
 * Au-delà de ce recouvrement, une navigation de pied de page n'est qu'un ÉCHO
 * du menu principal, pas un maillage éditorial à exploiter.
 */
const FOOTER_ECHO_THRESHOLD = 0.7;

interface Collected {
  total: number;
  internal: number;
  external: number;
  externalWithoutNofollow: number;
  invalidPhones: number;
  invalidEmails: number;
  linkMap: LinkEntry[];
  contentLinks: Set<string>;
  legalLinks: Set<string>;
  contentDetails: Map<string, ContentLinkDetail>;
  containerLinks: Map<string, ContentLinkDetail>;
  navTargets: Set<string>;
  footerCandidates: string[];
  selfReferences: Evidence[];
  danglingAnchors: Evidence[];
  items: CheckItem[];
  recommendations: string[];
}

interface Evidence {
  label: string;
  text: string;
  source: string | undefined;
}

export class LinksAnalyzer extends BaseAnalyzer {
  readonly id = 'LINKS';
  readonly title = 'Liens (CTC, CTM, nofollow, internes/externes)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const collected = this.collect(page, settings);
    this.summarize(collected);

    const failures = collected.items.filter(item => item.status === 'fail').length;
    const warnings = collected.items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore:
        failures >= 2 ? 0 : failures === 1 ? 2 : warnings >= 2 ? 3 : warnings === 1 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items: collected.items,
      summary: `${collected.total} lien(s) : ${collected.internal} interne(s), ${collected.external} externe(s) — ${collected.invalidPhones} téléphone(s) et ${collected.invalidEmails} adresse(s) invalides.`,
      recommendations: collected.recommendations,
      contentLinks: [...collected.contentLinks],
      legalLinks: [...collected.legalLinks],
      contentLinkDetails: [...collected.contentDetails.values()],
      footerLinks: this.exclusiveFooterLinks(page, collected),
      linkMap: collected.linkMap,
      containerLinks: [...collected.containerLinks.values()],
    });
  }

  private collect(page: HtmlPage, settings: EffectiveSettings): Collected {
    const { $ } = page;
    const currentUrl = normalizeUrl(page.url);
    const state: Collected = {
      total: 0,
      internal: 0,
      external: 0,
      externalWithoutNofollow: 0,
      invalidPhones: 0,
      invalidEmails: 0,
      linkMap: [],
      contentLinks: new Set(),
      legalLinks: new Set(),
      contentDetails: new Map(),
      containerLinks: new Map(),
      navTargets: new Set(),
      footerCandidates: [],
      selfReferences: [],
      danglingAnchors: [],
      items: [],
      recommendations: [],
    };

    $('a').each((_, element) => {
      this.readAnchor(page, $(element), $.html(element), settings, currentUrl, state);
    });

    this.readContainers(page, settings, state);
    return state;
  }

  private readAnchor(
    page: HtmlPage,
    node: Selection,
    outerHtml: string,
    settings: EffectiveSettings,
    currentUrl: string,
    state: Collected,
  ): void {
    const href = node.attr('href')?.trim() ?? '';
    const text = node.text().trim();
    const rel = node.attr('rel') ?? '';
    const elementType = node.attr('data-element-type');
    const isPhone = elementType === 'clicktocall' || href.startsWith('tel:');
    const isMail = elementType === 'clicktomail' || href.startsWith('mailto:');

    state.total += 1;

    if (!href && !isPhone && !isMail) {
      state.danglingAnchors.push({
        label: text ? `« ${text.slice(0, 80)} »` : '<a> sans texte',
        text,
        source: truncateSource(outerHtml),
      });
      return;
    }

    const zone = detectLinkZone(node);
    // UNE seule descente à la recherche d'une image : elle servait deux fois,
    // pour l'ancre de repli et pour le type du lien.
    const image = firstImageIn(firstElementOf(node));
    const imageAlt = image?.attribs?.['alt']?.trim() ?? '';
    const anchor = text || imageAlt || href;
    const targetIsAnchor = href.startsWith('#');
    const type = linkTypeOf(node, {
      isPhone,
      isMail,
      targetIsAnchor,
      hasText: Boolean(text),
      hasImage: image !== null,
      zone,
    });
    const resolved = isPhone || isMail || targetIsAnchor ? href : absolute(href, page.url);

    state.linkMap.push({
      href: resolved,
      anchor,
      zone,
      type,
      isInternal: isPhone || isMail || targetIsAnchor ? false : sameHost(resolved, page.url),
      isGenericAnchor: GENERIC_ANCHORS.has(anchor.toLowerCase().trim()),
      rel: rel || undefined,
      targetIsAnchor,
    });

    if (isPhone) return this.judgePhone(node, href, text, outerHtml, state);
    if (isMail) return this.judgeMail(node, href, text, outerHtml, state);

    // Ancres internes, `javascript:` et `data:` ne mènent nulle part hors de la
    // page : elles n'entrent ni dans le maillage ni dans le décompte.
    if (targetIsAnchor || href.startsWith('javascript:') || href.startsWith('data:')) return;
    if (!resolved.startsWith('http')) return;
    if (isExcludedDomain(resolved, settings.links.excludedDomains)) return;

    if (!sameHost(resolved, page.url)) {
      state.external += 1;
      if (!rel.toLowerCase().includes('nofollow')) state.externalWithoutNofollow += 1;
      return;
    }

    state.internal += 1;
    this.classifyInternal(node, resolved, anchor, type, zone, text, outerHtml, currentUrl, state);
  }

  private judgePhone(
    node: Selection,
    href: string,
    text: string,
    outerHtml: string,
    state: Collected,
  ): void {
    const raw = (
      href.startsWith('tel:') ? href.slice('tel:'.length) : (node.attr('phone') ?? '')
    ).replace(/[\s.-]/g, '');
    if (!raw || PHONE_NATIONAL.test(raw) || PHONE_E164.test(raw)) return;

    state.invalidPhones += 1;
    state.items.push({
      key: 'LINKS.ctc_invalid',
      label: `Numéro de téléphone invalide : « ${raw} »`,
      status: 'fail',
      detail: 'Format attendu : 0XXXXXXXXX ou +33XXXXXXXXX.',
      ...(text ? { locator: locateFromText(text) } : {}),
      source: truncateSource(outerHtml),
    });
    state.recommendations.push(`Corriger le numéro « ${raw} » du lien d'appel.`);
  }

  private judgeMail(
    node: Selection,
    href: string,
    text: string,
    outerHtml: string,
    state: Collected,
  ): void {
    const raw = href.startsWith('mailto:')
      ? (href.slice('mailto:'.length).split('?')[0] ?? '').trim()
      : (node.attr('emailextension') ?? '').trim();
    if (!raw || EMAIL_PATTERN.test(raw)) return;

    state.invalidEmails += 1;
    state.items.push({
      key: 'LINKS.ctm_invalid',
      label: `Adresse e-mail invalide : « ${raw} »`,
      status: 'fail',
      detail: 'Adresse malformée.',
      ...(text ? { locator: locateFromText(text) } : {}),
      source: truncateSource(outerHtml),
    });
    state.recommendations.push(`L'adresse « ${raw} » semble invalide.`);
  }

  private classifyInternal(
    node: Selection,
    resolved: string,
    anchor: string,
    type: LinkType,
    zone: LinkZone,
    text: string,
    outerHtml: string,
    currentUrl: string,
    state: Collected,
  ): void {
    const normalized = normalizeUrl(resolved);
    const inNavigation = isInNavigationContainer(node);
    const inShop = isInShopZone(node);

    if (isInLegalTitledContainer(node)) state.legalLinks.add(normalized);

    if (inShop) return;

    if (!inNavigation) {
      state.contentLinks.add(normalized);
      if (!state.contentDetails.has(normalized)) {
        state.contentDetails.set(normalized, { url: normalized, type, zone, anchor });
      }
      this.detectSelfReference(
        resolved,
        normalized,
        currentUrl,
        zone,
        anchor,
        text,
        outerHtml,
        state,
      );
      return;
    }

    // Une navigation SECONDAIRE placée dans le pied de page est classée « menu »
    // par la zone la plus proche : on teste donc l'ancrage explicite, sans quoi
    // elle serait confondue avec le menu principal.
    if (zone === 'footer' || isInFooterZone(node)) {
      if (!isInLegalTitledContainer(node) && !state.footerCandidates.includes(normalized)) {
        state.footerCandidates.push(normalized);
      }
      return;
    }

    if (zone === 'nav' || zone === 'header') state.navTargets.add(normalized);
  }

  /**
   * Lien qui renvoie à la page courante.
   *
   * Hors navigation seulement : un menu peut légitimement mettre en évidence la
   * page active. Une ancre vers une section de la même page n'en est pas un non
   * plus — c'est une navigation intra-page.
   */
  private detectSelfReference(
    resolved: string,
    normalized: string,
    currentUrl: string,
    zone: LinkZone,
    anchor: string,
    text: string,
    outerHtml: string,
    state: Collected,
  ): void {
    if (normalized !== currentUrl || NAVIGATION_ZONES.has(zone)) return;
    if (hasFragment(resolved)) return;

    state.selfReferences.push({
      label: `« ${anchor.slice(0, 80)} » (zone : ${zone})`,
      text,
      source: truncateSource(outerHtml),
    });
  }

  /**
   * Conteneurs cliquables, collectés À PART du maillage de contenu.
   *
   * Une navigation en JavaScript est un confort d'interface : elle ne transmet
   * aucun signal aux moteurs, et ne doit donc ni compter dans le maillage ni
   * empêcher une page d'être considérée comme orpheline.
   */
  private readContainers(page: HtmlPage, settings: EffectiveSettings, state: Collected): void {
    const { $ } = page;

    $('[data-link-on-container]').each((_, element) => {
      const node = $(element);
      const raw = node.attr('data-link-on-container')?.trim() ?? '';
      if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('data:')) {
        return;
      }

      const resolved = absolute(raw, page.url);
      if (!resolved.startsWith('http')) return;
      if (isExcludedDomain(resolved, settings.links.excludedDomains)) return;
      if (!sameHost(resolved, page.url)) return;
      if (isInShopZone(node)) return;

      const normalized = normalizeUrl(resolved);
      if (state.containerLinks.has(normalized)) return;

      state.containerLinks.set(normalized, {
        url: normalized,
        type: 'container',
        zone: detectLinkZone(node),
        anchor: node.text().trim().slice(0, 120) || raw,
      });
    });
  }

  private summarize(state: Collected): void {
    state.items.unshift(
      { key: 'LINKS.total', label: `${state.total} lien(s) au total`, status: 'pass' },
      { key: 'LINKS.internal', label: `${state.internal} lien(s) interne(s)`, status: 'pass' },
      { key: 'LINKS.external', label: `${state.external} lien(s) externe(s)`, status: 'pass' },
    );

    if (state.externalWithoutNofollow > 0) {
      state.items.push({
        key: 'LINKS.external_nofollow',
        label: `${state.externalWithoutNofollow} lien(s) externe(s) sans nofollow`,
        status: 'warning',
        detail: 'Envisager rel="nofollow" ou rel="noopener noreferrer".',
      });
      state.recommendations.push(
        `${state.externalWithoutNofollow} lien(s) externe(s) n'ont pas rel="nofollow" : vérifier que c'est intentionnel.`,
      );
    }

    if (state.danglingAnchors.length > 0) {
      state.items.push({
        key: 'LINKS.empty_anchors',
        label: `${state.danglingAnchors.length} lien(s) sans href`,
        status: 'warning',
      });
      pushEvidence(state.items, 'LINKS.empty_anchors', state.danglingAnchors);
      state.recommendations.push(
        `Supprimer ou compléter ${state.danglingAnchors.length} ancre(s) sans destination.`,
      );
    }

    if (state.selfReferences.length > 0) {
      state.items.push({
        key: 'LINKS.self_reference',
        label: `${state.selfReferences.length} lien(s) qui renvoient à la page courante`,
        status: 'fail',
        detail: state.selfReferences.map(evidence => evidence.label).join('\n'),
      });
      pushEvidence(state.items, 'LINKS.self_reference', state.selfReferences);
      state.recommendations.push(
        `Corriger ${state.selfReferences.length} lien(s) qui renvoient l'utilisateur là où il se trouve déjà.`,
      );
    }

    if (state.internal === 0 && state.external === 0) {
      state.items.push({
        key: 'LINKS.no_http',
        label: 'Aucun lien HTTP trouvé',
        status: 'warning',
      });
      state.recommendations.push(
        'Ajouter des liens internes : sans maillage, la page reste isolée du reste du site.',
      );
    }
  }

  /**
   * Liens du pied de page ABSENTS du menu principal.
   *
   * Ils trahissent un maillage éditorial délibéré — des pages exposées partout
   * sans figurer au menu. Mais si l'essentiel du pied de page reprend déjà le
   * menu, ce n'est qu'un écho : on écarte alors la navigation entière, plutôt
   * que de laisser passer les quelques liens non concordants.
   */
  private exclusiveFooterLinks(page: HtmlPage, state: Collected): string[] {
    const navTargets = new Set(state.navTargets);

    // La navigation déclarée par l'éditeur fait autorité sur le DOM : une page
    // au menu que la détection de zone aurait manquée ne doit pas être prise
    // pour un lien de pied de page exclusif.
    for (const navPage of extractDudaNavPages(page.html, page.url)) {
      if (navPage.inNavigation) navTargets.add(normalizeUrl(navPage.url));
    }

    if (state.footerCandidates.length === 0) return [];

    const overlap = state.footerCandidates.filter(url => navTargets.has(url)).length;
    if (overlap / state.footerCandidates.length >= FOOTER_ECHO_THRESHOLD) return [];

    return state.footerCandidates.filter(url => !navTargets.has(url));
  }
}

function linkTypeOf(
  node: Selection,
  context: {
    isPhone: boolean;
    isMail: boolean;
    targetIsAnchor: boolean;
    hasText: boolean;
    hasImage: boolean;
    zone: LinkZone;
  },
): LinkType {
  if (context.isPhone) return 'ctc';
  if (context.isMail) return 'ctm';
  if (context.targetIsAnchor) return 'text';

  if (context.hasImage && context.hasText) return 'mixed';
  if (context.hasImage) return 'image';

  const element = firstElementOf(node);
  const isButton = element !== null && classIncludesAny(element, BUTTON_CLASS_PARTS);
  if (isButton || context.zone === 'cta') return 'button';
  return 'text';
}

/** Détail par élément, en `info` : il porte l'ancrage sans peser sur la note. */
function pushEvidence(items: CheckItem[], key: string, evidence: readonly Evidence[]): void {
  for (const entry of evidence) {
    items.push({
      key,
      label: `↳ ${entry.label}`,
      status: 'info',
      ...(entry.text ? { locator: locateFromText(entry.text) } : {}),
      ...(entry.source ? { source: entry.source } : {}),
    });
  }
}

function absolute(href: string, pageUrl: string): string {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return href;
  }
}

function sameHost(href: string, pageUrl: string): boolean {
  try {
    return new URL(href, pageUrl).hostname === new URL(pageUrl).hostname;
  } catch {
    return false;
  }
}

/** Deux URL désignent la même page à un fragment ou un slash final près. */
function normalizeUrl(href: string): string {
  try {
    const parsed = new URL(href);
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return parsed.href;
  } catch {
    return href;
  }
}

function hasFragment(href: string): boolean {
  try {
    return new URL(href).hash !== '';
  } catch {
    return false;
  }
}

/**
 * Exclusion par HÔTE, jamais par sous-chaîne d'URL.
 *
 * La v1 comparait `url.includes(domaine)` : un profil excluant `mappy.com`
 * écartait aussi `https://faux-mappy.com.exemple.fr/` et toute URL portant ce
 * texte dans ses paramètres — c'est-à-dire des liens que l'auteur d'une page
 * pouvait faire ignorer à volonté.
 */
function isExcludedDomain(url: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some(domain => {
      const candidate = domain.toLowerCase().trim();
      return candidate && (hostname === candidate || hostname.endsWith(`.${candidate}`));
    });
  } catch {
    return false;
  }
}
