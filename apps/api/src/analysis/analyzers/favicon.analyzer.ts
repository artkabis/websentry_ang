import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/** CDN de l'éditeur Duda : une favicon servie depuis là n'a pas été personnalisée. */
const DUDA_CDN_HOST = 'static.cdn-website.com';

export class FaviconAnalyzer extends BaseAnalyzer {
  readonly id = 'FAVICON';
  readonly title = 'Favicon';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const standard = $('link[rel="icon"], link[rel="shortcut icon"]');
    const appleTouch = $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]');

    if (standard.length === 0 && appleTouch.length === 0) {
      return Promise.resolve(
        this.fail(
          [{ key: 'FAVICON.missing', label: 'Favicon absente', status: 'fail' }],
          'Aucune favicon détectée dans la page.',
          ['Ajouter <link rel="icon" href="/favicon.ico"> dans le <head> de chaque page.'],
        ),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.judgeStandard(
      standard.first().attr('href'),
      standard.length,
      page,
      items,
      recommendations,
    );
    this.judgeAppleTouch(
      appleTouch.first().attr('href'),
      appleTouch.length,
      page,
      items,
      recommendations,
    );

    const sizes = $('link[rel="icon"][sizes], link[rel="apple-touch-icon"][sizes]');
    if (sizes.length > 0) {
      items.push({
        key: 'FAVICON.sizes',
        label: `${sizes.length} taille(s) de favicon déclarée(s)`,
        value: sizes.length,
        status: 'pass',
      });
    }

    const warnings = items.filter(item => item.status === 'warning').length;
    return Promise.resolve(
      warnings > 0
        ? this.warn(items, 'Favicon présente mais configuration incomplète.', recommendations)
        : this.pass(items, 'Favicon correctement intégrée.'),
    );
  }

  private judgeStandard(
    href: string | undefined,
    count: number,
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (count === 0) {
      items.push({
        key: 'FAVICON.missing',
        label: 'Favicon standard absente',
        status: 'warning',
      });
      recommendations.push('Ajouter <link rel="icon"> en complément de l’apple-touch-icon.');
      return;
    }

    if (isEditorDefault(href, page.url)) {
      items.push({
        key: 'FAVICON.duda_default',
        label: 'Favicon par défaut Duda (non personnalisée)',
        value: href,
        status: 'warning',
      });
      recommendations.push(
        'La favicon est celle par défaut de l’éditeur Duda. La personnaliser dans les paramètres du site.',
      );
      return;
    }

    items.push({ key: 'FAVICON.present', label: 'Favicon présente', value: href, status: 'pass' });
  }

  private judgeAppleTouch(
    href: string | undefined,
    count: number,
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (count === 0) {
      items.push({
        key: 'FAVICON.apple_touch_missing',
        label: 'Apple Touch Icon absent',
        status: 'warning',
      });
      recommendations.push(
        'Ajouter <link rel="apple-touch-icon" href="…"> pour l’affichage sur iOS.',
      );
      return;
    }

    if (isEditorDefault(href, page.url)) {
      items.push({
        key: 'FAVICON.duda_default',
        label: 'Apple Touch Icon par défaut Duda (non personnalisé)',
        value: href,
        status: 'warning',
      });
      recommendations.push(
        'L’Apple Touch Icon est celui par défaut de l’éditeur Duda. Le personnaliser dans les paramètres du site.',
      );
      return;
    }

    items.push({
      key: 'FAVICON.apple_touch',
      label: 'Apple Touch Icon présent',
      value: href,
      status: 'pass',
    });
  }
}

/**
 * L'icône vient-elle du CDN de l'éditeur ?
 *
 * L'URL est résolue contre celle de la page. La v1 appelait `new URL(href)`
 * seul : un href protocole-relatif (`//static.cdn-website.com/…`), forme que
 * Duda émet couramment, y levait une exception silencieusement avalée, et la
 * favicon par défaut passait alors pour personnalisée.
 */
function isEditorDefault(href: string | undefined, pageUrl: string): boolean {
  if (!href) return false;
  try {
    return new URL(href, pageUrl).hostname === DUDA_CDN_HOST;
  } catch {
    return false;
  }
}
