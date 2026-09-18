import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';
import { verdictOf } from '../verdict.js';

/**
 * Balise canonical.
 *
 * Son absence expose au contenu dupliqué ; sa présence en double est pire,
 * parce que le moteur les ignore alors toutes les deux et choisit seul.
 */
export class CanonicalAnalyzer extends BaseAnalyzer {
  readonly id = 'CANONICAL';
  readonly title = 'Balise canonical';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const canonicals = $('link[rel="canonical"]');

    if (canonicals.length === 0) {
      return Promise.resolve(
        this.fail(
          [{ key: 'CANONICAL.missing', label: 'Balise canonical manquante', status: 'fail' }],
          'Aucune balise <link rel="canonical"> trouvée.',
          [
            'Ajouter <link rel="canonical" href="…"> dans le <head> pour désigner l’URL de référence.',
          ],
        ),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    if (canonicals.length > 1) {
      items.push({
        key: 'CANONICAL.multiple',
        label: `${canonicals.length} balises canonical trouvées`,
        status: 'fail',
        detail: 'Une seule balise canonical est autorisée.',
      });
      recommendations.push(
        'Ne conserver qu’une canonical : plusieurs se neutralisent, et le moteur choisit seul.',
      );
    }

    const href = (canonicals.first().attr('href') ?? '').trim();
    if (!href) {
      items.push({ key: 'CANONICAL.no_href', label: 'Canonical sans href', status: 'fail' });
      recommendations.push('Renseigner l’attribut href de la balise canonical.');
      return Promise.resolve(this.fail(items, 'Canonical vide.', recommendations));
    }

    items.push({ key: 'CANONICAL.url_ok', label: `Canonical : ${href}`, status: 'pass' });
    this.inspectHref(href, page.url, items, recommendations);

    const verdict = verdictOf(items);
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: verdict.globalScore,
      status: verdict.status,
      items,
      summary: `Canonical : ${href}`,
      recommendations,
    });
  }

  private inspectHref(
    href: string,
    pageUrl: string,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    let canonical: URL;
    let current: URL;
    try {
      // La canonical peut être relative : la résoudre contre l'URL de la page
      // est ce que fait le moteur, et la refuser serait un faux positif.
      canonical = new URL(href, pageUrl);
      current = new URL(pageUrl);
    } catch {
      items.push({
        key: 'CANONICAL.invalid_url',
        label: 'Canonical : URL invalide',
        status: 'fail',
        value: href,
      });
      recommendations.push(`« ${href} » n’est pas une URL exploitable.`);
      return;
    }

    if (canonical.hostname !== current.hostname) {
      items.push({
        key: 'CANONICAL.cross_domain',
        label: 'Canonical pointant vers un autre domaine',
        status: 'warning',
        value: href,
        detail: `Domaine de la page : ${current.hostname}`,
      });
      recommendations.push(
        `Vérifier que la canonical vers « ${canonical.hostname} » est intentionnelle : ` +
          'elle transfère l’indexation à un autre site.',
      );
    }

    if (canonical.search || canonical.hash) {
      items.push({
        key: 'CANONICAL.query_fragment',
        label: 'Canonical contenant une query string ou un fragment',
        status: 'warning',
        value: href,
      });
      recommendations.push(
        'Retirer paramètres et fragment de la canonical : ils créent autant d’URL distinctes.',
      );
    }

    if (canonical.protocol === 'http:' && current.protocol === 'https:') {
      items.push({
        key: 'CANONICAL.http',
        label: 'Canonical en HTTP alors que la page est en HTTPS',
        status: 'warning',
        value: href,
      });
      recommendations.push('Passer la canonical en HTTPS, comme la page elle-même.');
    }
  }
}
