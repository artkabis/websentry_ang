import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { HtmlPage } from '../page.model.js';
import { gradedVerdict } from '../verdict.js';

/** Seuls H1 et H2 portent le poids SEO qui justifie une contrainte de longueur. */
const CHECKED_TAGS = ['h1', 'h2'] as const;
type CheckedTag = (typeof CHECKED_TAGS)[number];

interface Heading {
  tag: CheckedTag;
  text: string;
  source: string | undefined;
}

export class HnLengthAnalyzer extends BaseAnalyzer {
  readonly id = 'HN_LENGTH';
  readonly title = 'Longueur des titres (H1 et H2)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const headings = this.collect(page);
    if (headings.length === 0) {
      // Pas d'échec : l'absence de titre est le sujet de HN_STRUCTURE, et la
      // signaler ici la compterait deux fois dans le score global.
      return Promise.resolve(
        this.pass(
          [{ key: 'HN_LENGTH.no_h1_h2', label: 'Aucun H1/H2 à vérifier', status: 'info' }],
          'Aucun H1 ou H2 détecté sur la page.',
        ),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];
    for (const heading of headings) this.judge(heading, settings, items, recommendations);

    // Barème dégressif : cinq titres hors bornes sont plus graves qu'un seul.
    const verdict = gradedVerdict(items);
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: verdict.globalScore,
      status: verdict.status,
      items,
      summary: `${headings.length} titre(s) H1/H2 vérifiés — ${verdict.failures} trop court(s), ${verdict.warnings} trop long(s).`,
      recommendations,
    });
  }

  private collect(page: HtmlPage): Heading[] {
    const { $ } = page;
    const headings: Heading[] = [];

    $(CHECKED_TAGS.join(',')).each((_, element) => {
      const tag = ($(element).prop('tagName') ?? '').toLowerCase();
      const text = $(element).text().trim();
      // Un titre vide relève de la structure, pas de la longueur : le mesurer
      // ici produirait un « trop court » qui masque le vrai problème.
      if (!text || !isCheckedTag(tag)) return;
      headings.push({ tag, text, source: truncateSource($.html(element)) });
    });

    return headings;
  }

  private judge(
    heading: Heading,
    settings: EffectiveSettings,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    // Les bornes par balise viennent d'une règle de page ; à défaut, la règle
    // générale s'applique aux deux niveaux.
    const override = settings.hnByTag?.[heading.tag];
    const min = override?.minLength ?? settings.hn.minLength;
    const max = override?.maxLength ?? settings.hn.maxLength;
    const length = heading.text.length;

    if (length < min) {
      items.push({
        key: 'HN_LENGTH.too_short',
        label: `<${heading.tag}> trop court (${length} car.)`,
        status: 'fail',
        detail: `« ${heading.text} » (minimum ${min})`,
        locator: locateFromText(heading.text),
        source: heading.source,
      });
      recommendations.push(
        `Le titre « ${heading.text} » est trop court (minimum ${min} caractères).`,
      );
      return;
    }

    if (length > max) {
      items.push({
        key: 'HN_LENGTH.too_long',
        label: `<${heading.tag}> trop long (${length} car.)`,
        status: 'warning',
        detail: `« ${heading.text} » (maximum ${max})`,
        locator: locateFromText(heading.text),
        source: heading.source,
      });
      recommendations.push(
        `Le titre « ${heading.text.slice(0, 40)}… » est trop long (maximum ${max} caractères).`,
      );
      return;
    }

    items.push({
      key: 'HN_LENGTH.ok',
      label: `<${heading.tag}> longueur correcte (${length} car.)`,
      status: 'pass',
      detail: `« ${heading.text} »`,
    });
  }
}

function isCheckedTag(tag: string): tag is CheckedTag {
  return (CHECKED_TAGS as readonly string[]).includes(tag);
}
