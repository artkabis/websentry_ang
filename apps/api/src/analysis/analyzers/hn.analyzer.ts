import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { HtmlPage } from '../page.model.js';

const HN_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** Nombre de H2 en deçà duquel la page est jugée insuffisamment structurée. */
const MIN_H2 = 2;

interface Heading {
  tag: string;
  text: string;
  level: number;
  source?: string;
}

/**
 * Hiérarchie des titres.
 *
 * Quatre règles : un H1 et un seul, le premier titre est ce H1, au moins deux
 * H2, et aucun saut de niveau. Les mots courants sont signalés à titre
 * INFORMATIF — ils n'entament pas la note, parce qu'un titre peut légitimement
 * contenir « le » ou « de ».
 */
export class HnAnalyzer extends BaseAnalyzer {
  readonly id = 'HN_STRUCTURE';
  readonly title = 'Hiérarchie des titres';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const headings = collectHeadings(page);
    if (headings.length === 0) {
      return Promise.resolve(
        this.fail([], 'Aucun titre (Hn) trouvé sur la page.', [
          'Ajouter un H1 unique décrivant le sujet principal de la page.',
          'Structurer le contenu avec des H2 et H3 pour les sous-sections.',
        ]),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.checkH1(headings, items, recommendations);
    this.checkFirstIsH1(headings, items, recommendations);
    this.checkH2Count(headings, items, recommendations);
    this.checkContinuity(headings, items, recommendations);
    this.reportCommonWords(headings, settings.hn.excludedWords, items);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: scoreOf(failures, warnings),
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary:
        `${headings.length} titre(s) analysé(s) — ` +
        `${failures} erreur(s), ${warnings} avertissement(s).`,
      recommendations,
    });
  }

  private checkH1(headings: Heading[], items: CheckItem[], recommendations: string[]): void {
    const h1List = headings.filter(heading => heading.level === 1);

    if (h1List.length === 0) {
      items.push({
        key: 'HN.h1_missing',
        label: 'H1 manquant',
        status: 'fail',
        detail: 'Aucun H1 trouvé sur la page.',
      });
      recommendations.push('Ajouter un H1 unique sur la page.');
      return;
    }

    const first = h1List[0] as Heading;
    if (h1List.length > 1) {
      items.push({
        key: 'HN.h1_duplicate',
        label: `H1 dupliqué (${h1List.length} fois)`,
        status: 'fail',
        detail: h1List.map(heading => `« ${heading.text} »`).join(', '),
        locator: locateFromText(first.text),
        source: first.source,
      });
      recommendations.push('Ne conserver qu’un seul H1 : il annonce le sujet unique de la page.');
      return;
    }

    items.push({
      key: 'HN.h1_unique',
      label: 'H1 unique',
      value: `« ${first.text} »`,
      status: 'pass',
      locator: locateFromText(first.text),
      source: first.source,
    });
  }

  private checkFirstIsH1(headings: Heading[], items: CheckItem[], recommendations: string[]): void {
    const first = headings[0] as Heading;
    if (first.level === 1) return;

    items.push({
      key: 'HN.first_not_h1',
      label: 'Le premier titre n’est pas un H1',
      status: 'warning',
      detail: `Premier titre rencontré : <${first.tag}>`,
      locator: locateFromText(first.text),
      source: first.source,
    });
    recommendations.push('Faire du H1 le premier titre de la page.');
  }

  private checkH2Count(headings: Heading[], items: CheckItem[], recommendations: string[]): void {
    const hasH1 = headings.some(heading => heading.level === 1);
    const h2Count = headings.filter(heading => heading.level === 2).length;

    if (hasH1 && h2Count < MIN_H2) {
      items.push({
        key: 'HN.h2_insufficient',
        label: `H2 insuffisants (${h2Count})`,
        status: 'warning',
        detail: `Au moins ${MIN_H2} H2 sont recommandés.`,
      });
      recommendations.push(`Structurer le contenu avec au moins ${MIN_H2} titres H2.`);
      return;
    }

    if (h2Count >= MIN_H2) {
      items.push({ key: 'HN.h2_count', label: `${h2Count} H2 trouvés`, status: 'pass' });
    }
  }

  /**
   * Continuité des niveaux.
   *
   * Un saut H2 → H4 casse la table des matières que produisent les lecteurs
   * d'écran : l'utilisateur croit avoir manqué une section.
   */
  private checkContinuity(
    headings: Heading[],
    items: CheckItem[],
    recommendations: string[],
  ): void {
    let continuous = true;

    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1] as Heading;
      const current = headings[index] as Heading;
      if (current.level <= previous.level + 1) continue;

      items.push({
        key: 'HN.hierarchy_break',
        label: `Saut de niveau : <${previous.tag}> → <${current.tag}>`,
        status: 'warning',
        detail: `« ${current.text} »`,
        locator: locateFromText(current.text),
        source: current.source,
      });
      recommendations.push(
        `Insérer un H${previous.level + 1} entre le H${previous.level} et le H${current.level}.`,
      );
      continuous = false;
    }

    if (continuous) {
      items.push({ key: 'HN.hierarchy_ok', label: 'Hiérarchie continue', status: 'pass' });
    }
  }

  private reportCommonWords(
    headings: Heading[],
    excludedWords: readonly string[],
    items: CheckItem[],
  ): void {
    const excluded = excludedWords.map(word => word.toLowerCase());

    for (const heading of headings) {
      const found = excluded.filter(word => containsWord(heading.text, word));
      if (found.length === 0) continue;

      items.push({
        key: 'HN.common_words',
        label: `<${heading.tag}> — mots courants détectés`,
        status: 'info',
        detail: `« ${heading.text} » — mots : ${found.join(', ')}`,
        locator: locateFromText(heading.text),
        source: heading.source,
      });
    }
  }
}

/** Titres de la page, dans l'ordre du document. */
function collectHeadings(page: HtmlPage): Heading[] {
  const { $ } = page;
  const headings: Heading[] = [];

  $(HN_TAGS.join(',')).each((_, element) => {
    const tag = ($(element).prop('tagName') ?? '').toLowerCase();
    headings.push({
      tag,
      text: $(element).text().trim(),
      level: Number.parseInt(tag.slice(1), 10),
      source: truncateSource($.html(element)),
    });
  });

  return headings;
}

/**
 * Le mot apparaît-il comme MOT ENTIER dans le texte ?
 *
 * Une simple inclusion signalerait « de » dans « demain » : le critère
 * deviendrait bruyant au point d'être ignoré.
 */
export function containsWord(text: string, word: string): boolean {
  const haystack = text.toLowerCase().trim();
  const needle = word.toLowerCase();
  return (
    haystack === needle ||
    haystack.startsWith(`${needle} `) ||
    haystack.endsWith(` ${needle}`) ||
    haystack.includes(` ${needle} `)
  );
}

/** Note d'ensemble — un échec pèse plus lourd qu'un avertissement. */
function scoreOf(failures: number, warnings: number): number {
  if (failures > 0) return Math.max(0, 3 - failures);
  if (warnings > 0) return Math.max(2, 4 - warnings);
  return 5;
}
