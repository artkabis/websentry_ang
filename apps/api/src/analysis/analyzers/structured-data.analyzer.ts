import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Types Schema.org STRUCTURELS — ils décrivent la page, pas une entité locale.
 *
 * Leur réclamer un nom, un contact et une adresse produirait trois
 * avertissements sur un fil d'Ariane parfaitement valide.
 */
const STRUCTURAL_TYPES: ReadonlySet<string> = new Set([
  'BreadcrumbList',
  'ListItem',
  'WebSite',
  'WebPage',
  'CollectionPage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'SiteLinksSearchBox',
  'SearchAction',
  'ImageObject',
  'VideoObject',
  'AudioObject',
  'MediaObject',
  'ItemList',
  'HowTo',
  'HowToStep',
  'Article',
  'NewsArticle',
  'BlogPosting',
  'Blog',
  'Product',
  'Offer',
  'AggregateOffer',
  'Review',
  'AggregateRating',
  'Person',
  'PostalAddress',
]);

/** Nombre d'images attendu dans un schéma d'entité, quand la règle est active. */
const EXPECTED_IMAGES = 5;

interface JsonLdNode {
  '@type'?: string | string[];
  [key: string]: unknown;
}

export class StructuredDataAnalyzer extends BaseAnalyzer {
  readonly id = 'STRUCTURED_DATA';
  readonly title = 'Données structurées (JSON-LD / Schema.org)';

  /**
   * Actif aussi quand seul le critère PARENT est listé.
   *
   * Le registre déclare ce critère `mergedInto: 'MENTIONS_LEGALES_DATA'`. Un
   * profil qui ne liste que le parent le désactiverait donc silencieusement, et
   * toute la détection JSON-LD disparaîtrait avec lui.
   */
  protected override isEnabled(settings: EffectiveSettings): boolean {
    if (settings.disabledChecks?.includes(this.id)) return false;
    if (!settings.enabledChecks) return true;
    return (
      settings.enabledChecks.includes(this.id) ||
      settings.enabledChecks.includes('MENTIONS_LEGALES_DATA')
    );
  }

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const items: CheckItem[] = [];
    const recommendations: string[] = [];
    const nodes = this.collect(page, items, recommendations);

    if (nodes.length === 0) {
      items.push({
        key: 'SD.no_json_ld',
        label: 'Aucune donnée structurée JSON-LD',
        status: 'warning',
      });
      recommendations.push(
        'Ajouter des données structurées JSON-LD (Organization, LocalBusiness, BreadcrumbList…) pour les résultats enrichis.',
      );
    } else {
      items.push({
        key: 'SD.json_ld_count',
        label: `${nodes.length} bloc(s) JSON-LD`,
        status: 'pass',
      });
      for (const node of nodes) this.judgeNode(node, settings, items, recommendations);
    }

    const microdata = page.$('[itemscope]').length;
    if (microdata > 0) {
      items.push({
        key: 'SD.microdata',
        label: `${microdata} bloc(s) Microdata détecté(s)`,
        status: 'pass',
        detail: 'Préférer JSON-LD pour les nouvelles implémentations.',
      });
    }

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures > 0 ? 1 : warnings >= 3 ? 2 : warnings >= 1 ? 3 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${nodes.length} bloc(s) JSON-LD, ${microdata} microdata.`,
      recommendations,
    });
  }

  /**
   * Rassemble tous les nœuds typés du document.
   *
   * `@graph` est APLATI. La v1 l'ignorait : un document `{"@context":…,
   * "@graph":[…]}` — forme la plus répandue, celle qu'émettent Yoast et la
   * plupart des générateurs — y était compté comme un unique bloc sans
   * `@type`. Le rapport signalait donc un défaut sur un balisage correct, et
   * ne voyait aucune des entités réellement déclarées.
   */
  private collect(page: HtmlPage, items: CheckItem[], recommendations: string[]): JsonLdNode[] {
    const { $ } = page;
    const nodes: JsonLdNode[] = [];
    let invalid = 0;

    $('script[type="application/ld+json"]').each((_, element) => {
      const raw = $(element).html()?.trim() ?? '';
      if (!raw) return;

      try {
        nodes.push(...flatten(JSON.parse(raw)));
      } catch {
        invalid += 1;
      }
    });

    if (invalid > 0) {
      items.push({
        key: 'SD.json_invalid',
        label: `${invalid} bloc(s) JSON-LD invalide(s) (syntaxe JSON incorrecte)`,
        status: 'fail',
      });
      recommendations.push('Corriger la syntaxe des blocs JSON-LD invalides.');
    }

    return nodes;
  }

  private judgeNode(
    node: JsonLdNode,
    settings: EffectiveSettings,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const types = typeNames(node);
    if (types.length === 0) {
      items.push({
        key: 'SD.type_missing',
        label: 'Bloc JSON-LD sans @type renseigné',
        status: 'warning',
      });
      recommendations.push(
        'Ajouter un @type valide (LocalBusiness, Organization, BreadcrumbList…) à chaque bloc JSON-LD.',
      );
      return;
    }

    const label = types.join(', ');
    items.push({ key: 'SD.type_block', label: `@type : ${label}`, status: 'pass' });

    // Un bloc qui porte NE SERAIT-CE QU'UN type structurel décrit la page :
    // `Notary`, `Dentist` ou `Restaurant` sont en revanche des sous-types de
    // LocalBusiness sans le mot dans leur nom, d'où l'exclusion par liste
    // plutôt que par motif.
    const isEntity = types.every(type => !STRUCTURAL_TYPES.has(type));
    if (isEntity) this.judgeEntity(node, label, settings, items, recommendations);

    if (types.includes('BreadcrumbList')) {
      const elements = node['itemListElement'];
      if (!Array.isArray(elements) || elements.length === 0) {
        items.push({
          key: 'SD.breadcrumb_empty',
          label: 'BreadcrumbList vide',
          status: 'warning',
        });
        recommendations.push('Ajouter des éléments (itemListElement) au BreadcrumbList.');
      }
    }
  }

  private judgeEntity(
    node: JsonLdNode,
    label: string,
    settings: EffectiveSettings,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (!node['name']) {
      items.push({
        key: 'SD.lb_name_missing',
        label: `${label} : « name » manquant`,
        status: 'warning',
      });
      recommendations.push(`Ajouter la propriété « name » au bloc ${label}.`);
    }

    if (!node['telephone'] && !node['email']) {
      items.push({
        key: 'SD.lb_contact_missing',
        label: `${label} : contact manquant (telephone/email)`,
        status: 'warning',
      });
      recommendations.push(`Ajouter « telephone » ou « email » au bloc ${label}.`);
    }

    if (!node['address']) {
      items.push({
        key: 'SD.lb_address_missing',
        label: `${label} : « address » manquant`,
        status: 'warning',
      });
      recommendations.push(`Ajouter « address » au bloc ${label}.`);
    }

    if (settings.structuredData?.requireFiveImages) {
      judgeImages(node, label, items, recommendations);
    }
  }
}

/**
 * Compte les images UNIQUES du schéma.
 *
 * Les doublons sont comptés à part : cinq fois la même image satisfait la
 * lettre de la règle sans en servir l'intention.
 */
function judgeImages(
  node: JsonLdNode,
  label: string,
  items: CheckItem[],
  recommendations: string[],
): void {
  const urls = imageUrls(node['image']);
  const unique = [...new Set(urls)];
  const duplicates = urls.length - unique.length;
  const duplicateUrls = [...new Set(urls.filter((url, index) => urls.indexOf(url) !== index))];
  const detail = duplicates > 0 ? `Doublons : ${duplicateUrls.join(' | ')}` : undefined;

  if (unique.length >= EXPECTED_IMAGES) {
    items.push({
      key: 'SD.lb_five_images',
      label:
        duplicates > 0
          ? `${label} : ${unique.length} images uniques sur ${urls.length} (${duplicates} doublon(s))`
          : `${label} : ${unique.length} images uniques dans le schéma`,
      status: duplicates > 0 ? 'warning' : 'pass',
      value: unique.join(' | '),
      ...(detail ? { detail } : {}),
    });
    if (duplicates > 0) {
      recommendations.push(
        `${duplicates} URL(s) d'image en doublon dans le schéma ${label}. Utiliser des images distinctes.`,
      );
    }
    return;
  }

  items.push({
    key: 'SD.lb_five_images',
    label:
      duplicates > 0
        ? `${label} : seulement ${unique.length} image(s) unique(s) sur ${urls.length} (${duplicates} doublon(s))`
        : `${label} : ${unique.length} image(s) — moins de ${EXPECTED_IMAGES} dans le schéma`,
    status: 'fail',
    ...(unique.length > 0 ? { value: unique.join(' | ') } : {}),
    ...(detail ? { detail } : {}),
  });
  recommendations.push(
    duplicates > 0
      ? `Remplacer les doublons d'URL dans « image » du schéma ${label} et atteindre ${EXPECTED_IMAGES} images uniques.`
      : `Ajouter au moins ${EXPECTED_IMAGES} images à la propriété « image » du schéma ${label}.`,
  );
}

/** Une image peut être une URL, un `ImageObject`, ou un tableau des deux. */
function imageUrls(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(single).filter((url): url is string => url !== null);
}

function single(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const url = record['url'] ?? record['contentUrl'];
    return typeof url === 'string' && url ? url : null;
  }
  return null;
}

/** Aplatit tableaux et `@graph`, récursivement, en nœuds exploitables. */
function flatten(parsed: unknown): JsonLdNode[] {
  if (Array.isArray(parsed)) return parsed.flatMap(entry => flatten(entry));
  if (!parsed || typeof parsed !== 'object') return [];

  const node = parsed as JsonLdNode;
  const graph = node['@graph'];
  if (graph !== undefined) {
    const inner = flatten(graph);
    // Un conteneur `@graph` qui porte lui-même un type est rare mais valide :
    // le perdre effacerait une entité réellement déclarée.
    return node['@type'] ? [node, ...inner] : inner;
  }

  return [node];
}

/** Types déclarés, normalisés — un `@type` vide vaut absence de type. */
function typeNames(node: JsonLdNode): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
}
