import type { CheckItem, CheckResult, LinkZone } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { ZONE_LABEL, detectLinkZone, isButtonLink } from '../link-zone.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { NetworkProbe, ProbeResult } from '../network-probe.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Liens cassés.
 *
 * Un 4xx n'est pas toujours un lien mort : les réseaux sociaux et les pare-feux
 * applicatifs répondent 403, 429 ou 999 à tout ce qui ressemble à un robot. Les
 * confondre avec des 404 remplirait le rapport de faux positifs que personne ne
 * peut corriger — ils sont donc classés « à vérifier », pas « cassé ».
 */

/** Schémas qui ne désignent pas une ressource HTTP à vérifier. */
const SKIPPED_SCHEMES = ['mailto:', 'tel:', 'javascript:', '#', 'data:', 'sms:'];

/** Plafond de liens vérifiés par page — borne le temps et les requêtes sortantes. */
const MAX_CHECKED = 200;
/** Plafond de l'inventaire des liens valides — borne le poids du rapport. */
const MAX_INVENTORY = 150;

/** Statuts qui trahissent un refus opposé aux robots, pas une ressource absente. */
const BOT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 999]);

/** Domaines qui limitent systématiquement les robots. */
const RATE_LIMITED_DOMAINS: readonly string[] = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'pinterest.com',
  'pinterest.fr',
  'youtube.com',
  'youtu.be',
  'tripadvisor.com',
  'tripadvisor.fr',
];

type LinkKind = 'text' | 'image' | 'mixed' | 'button' | 'container';

const KIND_LABEL: Record<LinkKind, string> = {
  text: 'intext',
  image: 'image',
  mixed: 'mixte',
  button: 'bouton',
  container: 'conteneur',
};

interface LinkElement {
  url: string;
  text: string;
  kind: LinkKind;
  zone: LinkZone;
  source: string | undefined;
}

export class BrokenLinksAnalyzer extends BaseAnalyzer {
  readonly id = 'BROKEN_LINKS';
  readonly title = 'Liens cassés (404, erreurs HTTP)';

  async analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return this.na();

    const elements = collectLinks(page, settings);
    const urls = [...new Set(elements.map(element => element.url))];

    if (urls.length === 0) {
      return this.na('Aucun lien HTTP à vérifier sur cette page.');
    }

    if (!net) {
      // Sans sortie réseau, on ne peut RIEN affirmer : annoncer « aucun lien
      // cassé » serait une conclusion sans vérification.
      return this.na('Vérification des liens impossible — sortie réseau indisponible.');
    }

    const checked = urls.slice(0, MAX_CHECKED);
    const results = await net.checkMany(checked);
    const sorted = sortResults(results);

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    if (urls.length > checked.length) {
      // Notice opérationnelle, SANS clé : ce n'est pas un sous-critère de
      // qualité et elle ne doit pas entrer dans le décompte des points de
      // contrôle.
      items.push({
        label: `${urls.length - checked.length} lien(s) non vérifié(s) — plafond de ${MAX_CHECKED} par page`,
        status: 'info',
        detail:
          'Les liens sont vérifiés dans leur ordre d’apparition, pour borner le temps d’analyse et le volume de requêtes émises vers le site.',
      });
    }

    const verified = checked.length - sorted.unverified.length;
    if (sorted.unverified.length > 0) {
      // Sans clé, comme la notice de plafond : ce n'est pas un sous-critère de
      // qualité, et la note du critère n'en tient pas compte.
      items.push({
        label: `${sorted.unverified.length} lien(s) non vérifié(s) — quota de requêtes atteint`,
        status: 'info',
        detail:
          'Le quota borne les requêtes émises par ce critère pour une page. Les liens concernés ne sont ni sains ni cassés : ils n’ont pas été interrogés.',
      });
    }

    const byUrl = index(elements);
    this.reportBroken(sorted.broken, byUrl, items, recommendations);
    this.reportUnreachable(sorted.unreachable, byUrl, items, recommendations);
    this.reportRedirected(sorted.redirected, byUrl, items);
    this.reportRefused(sorted.refused, items);
    this.reportInventory(sorted.healthy, elements, items);

    items.unshift({
      key: 'BROKEN.checked',
      label: 'Lien(s) vérifié(s)',
      status: 'pass',
      value: verified,
    });

    const failures = sorted.broken.length;
    const warnings = sorted.unreachable.length;

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures >= 3 ? 0 : failures >= 1 ? 2 : warnings > 2 ? 3 : warnings > 0 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary:
        `${verified} lien(s) vérifié(s) — ${failures} cassé(s), ${warnings} injoignable(s), ${sorted.redirected.length} redirection(s), ${sorted.refused.length} à vérifier manuellement` +
        (sorted.unverified.length > 0
          ? `, ${sorted.unverified.length} non vérifié(s) faute de quota.`
          : '.'),
      recommendations,
      // Alimente la réconciliation du maillage : un lien dont la cible redirige
      // vers une page joignable n'est PAS un futur 404.
      linkResolutions: [...sorted.healthy, ...sorted.redirected, ...sorted.refused].map(result => ({
        url: result.url,
        finalUrl: result.finalUrl || result.url,
        reachable: true,
        redirected: result.redirected,
      })),
    };
  }

  private reportBroken(
    broken: ProbeResult[],
    byUrl: Map<string, LinkElement>,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (broken.length === 0) {
      items.push({ key: 'BROKEN.no_broken', label: 'Aucun lien cassé détecté', status: 'pass' });
      return;
    }

    for (const result of broken) {
      items.push({
        key: 'BROKEN.broken',
        label: `${result.status} — ${result.url}${mention(byUrl.get(result.url))}`,
        status: 'fail',
        ...evidence(byUrl.get(result.url)),
      });
    }

    recommendations.push(
      `Corriger ou retirer ${broken.length} lien(s) en erreur : ${broken
        .slice(0, 3)
        .map(result => result.url)
        .join(', ')}${broken.length > 3 ? '…' : ''}`,
    );
  }

  private reportUnreachable(
    unreachable: ProbeResult[],
    byUrl: Map<string, LinkElement>,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (unreachable.length === 0) return;

    for (const result of unreachable) {
      items.push({
        key: 'BROKEN.timeout',
        label: `${result.error ?? 'Injoignable'} — ${result.url}${mention(byUrl.get(result.url))}`,
        status: 'warning',
        ...evidence(byUrl.get(result.url)),
      });
    }

    recommendations.push(
      `Vérifier manuellement ${unreachable.length} lien(s) injoignables (délai dépassé ou hôte hors ligne).`,
    );
  }

  /** Une redirection 301 vers HTTPS est normale : on l'expose sans la sanctionner. */
  private reportRedirected(
    redirected: ProbeResult[],
    byUrl: Map<string, LinkElement>,
    items: CheckItem[],
  ): void {
    for (const result of redirected) {
      items.push({
        key: 'BROKEN.redirected',
        label: `${result.url} → ${result.finalUrl}${mention(byUrl.get(result.url))}`,
        status: 'info',
        ...evidence(byUrl.get(result.url)),
      });
    }
  }

  private reportRefused(refused: ProbeResult[], items: CheckItem[]): void {
    if (refused.length === 0) return;

    items.push({
      key: 'BROKEN.rate_limited',
      label: `${refused.length} lien(s) à vérifier manuellement (accès refusé aux robots)`,
      status: 'info',
      detail: `${refused.map(result => `${result.status ?? '—'} — ${result.url}`).join('\n')}\nCes codes signalent un refus opposé aux robots, pas une page absente : le lien est probablement valide.`,
    });
  }

  /**
   * Inventaire des liens valides — un item par ÉLÉMENT cliquable.
   *
   * La même URL liée depuis le menu ET depuis le contenu apparaît deux fois,
   * avec sa zone propre : c'est ce qui permet de retrouver le lien dans la
   * page. Les doublons exacts (même URL, même type, même zone) sont écartés.
   */
  private reportInventory(
    healthy: ProbeResult[],
    elements: LinkElement[],
    items: CheckItem[],
  ): void {
    const statuses = new Map(healthy.map(result => [result.url, result.status ?? 200]));
    const seen = new Set<string>();

    const listed = elements.filter(element => {
      if (!statuses.has(element.url)) return false;
      const key = `${element.url}|${element.kind}|${element.zone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const element of listed.slice(0, MAX_INVENTORY)) {
      const zone = ZONE_LABEL[element.zone];
      items.push({
        key: 'BROKEN.link_valid',
        label: `${statuses.get(element.url) ?? 200} — ${element.url} — ${KIND_LABEL[element.kind]}${zone ? ` · ${zone}` : ''}`,
        status: 'info',
        locator: element.text ? locateFromText(element.text) : undefined,
        source: element.source,
      });
    }

    if (listed.length > MAX_INVENTORY) {
      items.push({
        key: 'BROKEN.link_valid',
        label: `+ ${listed.length - MAX_INVENTORY} autre(s) lien(s) valide(s) non listé(s)`,
        status: 'info',
      });
    }
  }
}

interface SortedResults {
  broken: ProbeResult[];
  unreachable: ProbeResult[];
  redirected: ProbeResult[];
  refused: ProbeResult[];
  healthy: ProbeResult[];
  /** Liens laissés de côté faute de quota — un manque de NOTRE part. */
  unverified: ProbeResult[];
}

function sortResults(results: readonly ProbeResult[]): SortedResults {
  const sorted: SortedResults = {
    unverified: [],
    broken: [],
    unreachable: [],
    redirected: [],
    refused: [],
    healthy: [],
  };

  for (const result of results) {
    // Un quota atteint n'est pas un constat sur le lien : il n'entre donc ni
    // dans les échecs ni dans les injoignables, et ne pèse pas sur la note.
    if (result.exhausted) {
      sorted.unverified.push(result);
    } else if (result.status === null) {
      sorted.unreachable.push(result);
    } else if (result.status >= 400) {
      const refusal =
        BOT_REFUSAL_STATUSES.has(result.status) ||
        (result.status === 429 && isRateLimited(result.url));
      (refusal ? sorted.refused : sorted.broken).push(result);
    } else if (result.redirected && result.finalUrl !== result.url) {
      sorted.redirected.push(result);
    } else {
      sorted.healthy.push(result);
    }
  }

  return sorted;
}

function isRateLimited(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return RATE_LIMITED_DOMAINS.some(
      domain => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function collectLinks(page: HtmlPage, settings: EffectiveSettings): LinkElement[] {
  const { $ } = page;
  const excluded = settings.links.excludedDomains;
  const elements: LinkElement[] = [];

  $('a[href]').each((_, element) => {
    const node = $(element);
    const url = resolve(node.attr('href')?.trim() ?? '', page.url);
    if (!url || isExcluded(url, excluded)) return;

    elements.push({
      url,
      text: node.text().trim(),
      kind: kindOf(node),
      zone: detectLinkZone(node),
      source: truncateSource($.html(element)),
    });
  });

  // Conteneur cliquable de l'éditeur : un bloc entier navigue au clic, sans
  // balise `<a>`. Le rater laisserait un lien cassé invisible au rapport.
  $('[data-link-on-container]').each((_, element) => {
    const node = $(element);
    const url = resolve(node.attr('data-link-on-container')?.trim() ?? '', page.url);
    if (!url || isExcluded(url, excluded)) return;

    elements.push({
      url,
      text: node.text().trim().slice(0, 120),
      kind: 'container',
      zone: detectLinkZone(node),
      source: truncateSource($.html(element)),
    });
  });

  return elements;
}

function kindOf(node: Selection): LinkKind {
  const hasImage = node.find('img').length > 0;
  const hasText = node.text().trim().length > 0;

  if (hasImage && hasText) return 'mixed';
  if (hasImage) return 'image';
  if (isButtonLink(node)) return 'button';
  return 'text';
}

/**
 * Résout un href en URL absolue vérifiable.
 *
 * Le cas particulier de l'aperçu : l'éditeur y génère des liens de boutique
 * portant le domaine de PRODUCTION alors que la page analysée est en aperçu.
 * Les vérifier tels quels testerait un autre environnement que celui audité.
 */
function resolve(href: string, pageUrl: string): string | null {
  if (!href || SKIPPED_SCHEMES.some(scheme => href.startsWith(scheme))) return null;

  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const resolved = new URL(normalized, pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;

    const current = new URL(pageUrl);
    if (resolved.origin !== current.origin) {
      const siteId = /^\/site\/([0-9a-f]{8,})/i.exec(current.pathname)?.[1];
      if (siteId && resolved.pathname.startsWith(`/site/${siteId}`)) {
        resolved.protocol = current.protocol;
        resolved.host = current.host;
      }
    }

    return resolved.href;
  } catch {
    return null;
  }
}

function isExcluded(url: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some(
      domain => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`),
    );
  } catch {
    return false;
  }
}

/** Premier élément rencontré pour chaque URL — celui qu'on montrera. */
function index(elements: readonly LinkElement[]): Map<string, LinkElement> {
  const byUrl = new Map<string, LinkElement>();
  for (const element of elements) {
    if (!byUrl.has(element.url)) byUrl.set(element.url, element);
  }
  return byUrl;
}

function mention(element: LinkElement | undefined): string {
  if (!element) return '';
  const zone = ZONE_LABEL[element.zone];
  return ` — ${KIND_LABEL[element.kind]}${zone ? ` · ${zone}` : ''}`;
}

function evidence(element: LinkElement | undefined): Partial<CheckItem> {
  if (!element) return {};
  return {
    ...(element.text ? { locator: locateFromText(element.text) } : {}),
    ...(element.source ? { source: element.source } : {}),
  };
}
