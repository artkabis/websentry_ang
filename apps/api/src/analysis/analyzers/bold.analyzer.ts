import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Mise en gras — quantité, contexte, contenu.
 *
 * Le gras n'a de valeur SEO que s'il distingue : trop rare, il ne met rien en
 * avant ; trop fréquent, il ne distingue plus rien. D'où une fourchette, et non
 * un minimum.
 */
export class BoldAnalyzer extends BaseAnalyzer {
  readonly id = 'BOLD';
  readonly title = 'Mise en gras (b/strong)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const { min, max, minParentWords } = settings.bold;
    const elements = $('b, strong');
    const count = elements.length;

    if (count === 0) {
      return Promise.resolve(
        this.warn(
          [{ key: 'BOLD.none', label: 'Aucun élément en gras', status: 'warning' }],
          'Aucune mise en gras trouvée.',
          ['Mettre en gras les expressions-clés importantes pour renforcer leur pertinence SEO.'],
          2,
        ),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.judgeCount(count, min, max, items, recommendations);
    this.judgeContext(page, minParentWords, items, recommendations);
    this.judgeEmpty(page, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: boldScore(failures, warnings),
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${count} élément(s) en gras trouvé(s).`,
      recommendations,
    });
  }

  private judgeCount(
    count: number,
    min: number,
    max: number,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (count < min) {
      items.push({
        key: 'BOLD.too_few',
        label: `Trop peu de mises en gras (${count})`,
        status: 'warning',
        detail: `Minimum recommandé : ${min}`,
      });
      recommendations.push(
        `Utiliser davantage de <strong>/<b> pour mettre en valeur les expressions-clés (minimum ${min}).`,
      );
      return;
    }

    if (count > max) {
      items.push({
        key: 'BOLD.too_many',
        label: `Trop de mises en gras (${count})`,
        status: 'warning',
        detail: `Maximum recommandé : ${max}`,
      });
      recommendations.push(
        `Réduire le nombre de mises en gras (${count} > ${max}) : trop d'emphase la dévalue.`,
      );
      return;
    }

    items.push({ key: 'BOLD.count_ok', label: `${count} mise(s) en gras`, status: 'pass' });
  }

  /** Un mot en gras dans un paragraphe de cinq mots ne met rien en valeur. */
  private judgeContext(
    page: HtmlPage,
    minParentWords: number,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const { $ } = page;
    let poor = 0;
    let first: { text: string; source: string | undefined } | undefined;

    $('b, strong').each((_, element) => {
      const words = $(element).parent().text().trim().split(/\s+/).filter(Boolean).length;
      if (words >= minParentWords) return;
      poor += 1;
      first ??= {
        text: $(element).text().trim(),
        source: truncateSource($.html(element)),
      };
    });

    if (poor === 0) {
      items.push({
        key: 'BOLD.context_ok',
        label: 'Contexte des mises en gras correct',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'BOLD.context_poor',
      label: `${poor} mise(s) en gras sans contexte suffisant`,
      status: 'warning',
      detail: `Le paragraphe parent doit contenir au moins ${minParentWords} mots.`,
      locator: first ? locateFromText(first.text) : undefined,
      source: first?.source,
    });
    recommendations.push(
      `${poor} balise(s) <strong>/<b> sont dans un contexte trop court (< ${minParentWords} mots). Enrichir le contenu parent.`,
    );
  }

  private judgeEmpty(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    let empty = 0;
    $('b, strong').each((_, element) => {
      if (!$(element).text().trim()) empty += 1;
    });

    if (empty === 0) return;

    items.push({
      key: 'BOLD.empty',
      label: `${empty} balise(s) en gras vide(s)`,
      status: 'fail',
    });
    recommendations.push(`Supprimer ${empty} balise(s) <strong>/<b> vide(s).`);
  }
}

/**
 * Barème propre au critère, repris de la v1.
 *
 * Il ne suit ni `verdictOf` ni `gradedVerdict` : un seul avertissement y vaut 4
 * et non 3, parce qu'une quantité de gras hors fourchette est une remarque de
 * confort, pas un défaut. Conserver ce barème garde les scores comparables à
 * ceux déjà stockés en base.
 */
function boldScore(failures: number, warnings: number): number {
  if (failures > 0) return 1;
  if (warnings >= 2) return 3;
  if (warnings === 1) return 4;
  return 5;
}
