import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Balises `title` et `meta description`.
 *
 * Deux balises, mais le critère le plus consulté du rapport : ce sont elles que
 * le moteur affiche, et leur absence se paie immédiatement en clics.
 */
export class MetasAnalyzer extends BaseAnalyzer {
  readonly id = 'METAS';
  readonly title = 'Balises méta (title & description)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.checkTitle($, settings, items, recommendations);
    this.checkDescription($, settings, items, recommendations);
    this.checkRobots($, page.url, items, recommendations);

    return Promise.resolve(this.summarize(items, recommendations));
  }

  private checkTitle(
    $: HtmlPage['$'],
    settings: EffectiveSettings,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const bounds = settings.meta.title;
    const title = $('title').first().text().trim();

    if (!title) {
      items.push({ key: 'METAS.title_missing', label: 'Title manquant', status: 'fail' });
      recommendations.push('Ajouter une balise <title> unique et descriptive.');
      return;
    }

    const length = title.length;
    if (length < bounds.min) {
      items.push({
        key: 'METAS.title_short',
        label: `Title trop court (${length} car.)`,
        value: title,
        status: 'warning',
        detail: `minimum ${bounds.min} caractères`,
      });
      recommendations.push(
        `Allonger le title : ${length} caractères pour un minimum de ${bounds.min}.`,
      );
      return;
    }

    if (length > bounds.max) {
      items.push({
        key: 'METAS.title_long',
        label: `Title trop long (${length} car.)`,
        value: title,
        status: 'warning',
        detail: `maximum ${bounds.max} caractères`,
      });
      recommendations.push(
        `Raccourcir le title : ${length} caractères pour un maximum de ${bounds.max} — au-delà, le moteur le tronque.`,
      );
      return;
    }

    items.push({
      key: 'METAS.title_ok',
      label: `Title (${length} car.)`,
      value: title,
      status: 'pass',
    });
  }

  private checkDescription(
    $: HtmlPage['$'],
    settings: EffectiveSettings,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const bounds = settings.meta.description;
    // Le sélecteur d'attribut est sensible à la casse en CSS, mais `name` ne
    // l'est pas en HTML : on cherche donc les deux graphies courantes.
    const description = (
      $('meta[name="description"]').attr('content') ??
      $('meta[name="Description"]').attr('content') ??
      ''
    ).trim();

    if (!description) {
      items.push({
        key: 'METAS.desc_missing',
        label: 'Meta description manquante',
        status: 'fail',
      });
      recommendations.push('Ajouter une meta description résumant le contenu de la page.');
      return;
    }

    const length = description.length;
    if (length < bounds.min) {
      items.push({
        key: 'METAS.desc_short',
        label: `Description trop courte (${length} car.)`,
        value: description,
        status: 'warning',
        detail: `minimum ${bounds.min} caractères`,
      });
      recommendations.push(
        `Étoffer la meta description : ${length} caractères pour un minimum de ${bounds.min}.`,
      );
      return;
    }

    if (length > bounds.max) {
      items.push({
        key: 'METAS.desc_long',
        label: `Description trop longue (${length} car.)`,
        value: description,
        status: 'warning',
        detail: `maximum ${bounds.max} caractères`,
      });
      recommendations.push(
        `Raccourcir la meta description : ${length} caractères pour un maximum de ${bounds.max}.`,
      );
      return;
    }

    items.push({
      key: 'METAS.desc_ok',
      label: `Meta description (${length} car.)`,
      value: description,
      status: 'pass',
    });
  }

  /**
   * Directive d'indexation.
   *
   * `noindex` sur une URL de PRÉVISUALISATION Duda est normal — c'est même
   * souhaitable. Le signaler en échec remplirait de rouge le rapport d'un site
   * en cours de construction, et apprendrait à l'équipe à ignorer ce critère.
   */
  private checkRobots(
    $: HtmlPage['$'],
    pageUrl: string,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const robots = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();
    if (!robots.includes('noindex')) return;

    if (isPreviewUrl(pageUrl)) {
      items.push({
        key: 'METAS.noindex_preview',
        label: 'noindex — normal sur une URL de prévisualisation',
        status: 'info',
        value: robots,
      });
      return;
    }

    items.push({
      key: 'METAS.noindex',
      label: 'La page est en noindex',
      status: 'fail',
      value: robots,
    });
    recommendations.push('Retirer la directive noindex : en l’état, la page ne sera pas indexée.');
  }

  private summarize(items: CheckItem[], recommendations: string[]): CheckResult {
    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    if (failures > 0) {
      return this.fail(
        items,
        `${failures} problème(s) bloquant(s) sur les balises méta.`,
        recommendations,
        failures === 1 ? 2 : 1,
      );
    }
    if (warnings > 0) {
      return this.warn(items, `${warnings} balise(s) méta à ajuster.`, recommendations);
    }
    return this.pass(items, 'Balises méta conformes.');
  }
}

/**
 * URL de prévisualisation, où `noindex` est attendu.
 *
 * Exporté pour être testé seul : la règle est partagée par plusieurs critères,
 * et se tromper de sens la rendrait soit inutile, soit bruyante.
 */
export function isPreviewUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.searchParams.has('preview') ||
      parsed.hostname.includes('responsivesiteeditor.com') ||
      parsed.hostname.includes('dudaadmin')
    );
  } catch {
    return false;
  }
}
