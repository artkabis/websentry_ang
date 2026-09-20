import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Accessibilité — ce qu'un document HTML suffit à établir.
 *
 * Le contraste, la taille de cible et l'ordre de lecture visuel demandent un
 * moteur de rendu : ils relèvent du critère CONTRAST_V2, pas d'ici. Ce critère
 * se limite à ce qui est vrai sans rendre la page, et le dit.
 */

/** Libellés qui signalent un lien d'évitement. */
const SKIP_HINTS = ['skip', 'aller au', 'aller à', 'contenu principal', 'passer'];

/** Rôles ARIA valides (WAI-ARIA 1.2). */
const VALID_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'dialog',
  'directory',
  'document',
  'feed',
  'figure',
  'form',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

/** Champs qui doivent porter un nom accessible. */
const LABELLED_FIELDS =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select';

/** Combien de liens fautifs citer dans le détail avant de s'arrêter. */
const MAX_REPORTED_LINKS = 10;

export class AccessibilityAnalyzer extends BaseAnalyzer {
  readonly id = 'ACCESSIBILITY';
  readonly title = 'Accessibilité (WCAG, ARIA)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.judgeSkipLink(page, items, recommendations);
    this.judgeLandmarks(page, items, recommendations);
    this.judgeImages(page, items, recommendations);
    this.judgeLinks(page, items, recommendations);
    this.judgeForms(page, items, recommendations);
    this.judgeTabindex(page, items, recommendations);
    this.judgeRoles(page, items, recommendations);
    this.judgeLang(page, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: accessibilityScore(failures, warnings),
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${failures} problème(s) bloquant(s), ${warnings} avertissement(s) d'accessibilité.`,
      recommendations,
    });
  }

  private judgeSkipLink(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const found = $('a[href^="#"]')
      .toArray()
      .some(element => {
        const text = $(element).text().toLowerCase();
        return SKIP_HINTS.some(hint => text.includes(hint));
      });

    if (found) {
      items.push({ key: 'A11Y.skip_ok', label: 'Lien d’évitement présent', status: 'pass' });
      return;
    }

    items.push({
      key: 'A11Y.skip_missing',
      label: 'Lien d’évitement (skip nav) absent',
      status: 'warning',
    });
    recommendations.push(
      'Ajouter un lien d’évitement en début de page (<a href="#contenu">Aller au contenu</a>) pour la navigation au clavier.',
    );
  }

  private judgeLandmarks(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const missing = [
      { selector: 'main, [role="main"]', label: '<main>' },
      { selector: 'nav, [role="navigation"]', label: '<nav>' },
      { selector: 'header, [role="banner"]', label: '<header>' },
      { selector: 'footer, [role="contentinfo"]', label: '<footer>' },
    ]
      .filter(({ selector }) => $(selector).length === 0)
      .map(({ label }) => label);

    if (missing.length === 0) {
      items.push({
        key: 'A11Y.structure_ok',
        label: 'Structure sémantique HTML5 présente',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'A11Y.structure_incomplete',
      label: 'Structure sémantique incomplète',
      status: 'warning',
      detail: `Éléments manquants : ${missing.join(', ')}`,
    });
    recommendations.push(
      `Ajouter les repères sémantiques ${missing.join(', ')} : ils permettent de naviguer de zone en zone au lecteur d'écran.`,
    );
  }

  private judgeImages(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    // `alt=""` est une DÉCLARATION (image décorative) ; seul l'attribut absent
    // est un défaut, car il laisse la technologie d'assistance lire l'URL.
    const missing = $('img')
      .toArray()
      .filter(element => $(element).attr('alt') === undefined).length;

    if (missing === 0) {
      items.push({
        key: 'A11Y.img_alt_ok',
        label: 'Toutes les images ont un attribut alt',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'A11Y.img_alt_missing',
      label: `${missing} image(s) sans attribut alt`,
      status: 'fail',
    });
    recommendations.push(`Ajouter l'attribut alt à ${missing} image(s) — WCAG 2.2, critère 1.1.1.`);
  }

  private judgeLinks(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const nameless: string[] = [];

    $('a').each((_, element) => {
      const node = $(element);
      // Un `alt` VIDE déclare l'image décorative : le lien n'a alors aucun nom
      // accessible, même s'il contient une image.
      const imageAlt = node.find('img[alt]').attr('alt')?.trim() ?? '';
      const named =
        node.text().trim() ||
        node.attr('aria-label')?.trim() ||
        node.attr('title')?.trim() ||
        imageAlt;
      if (named) return;
      nameless.push((node.attr('href')?.trim() || '(sans href)').slice(0, 80));
    });

    if (nameless.length === 0) {
      items.push({
        key: 'A11Y.links_ok',
        label: 'Tous les liens ont un nom accessible',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'A11Y.links_empty',
      label: `${nameless.length} lien(s) sans texte descriptif`,
      status: 'fail',
      detail: nameless.slice(0, MAX_REPORTED_LINKS).join(' | '),
    });
    recommendations.push(
      `${nameless.length} lien(s) n'ont pas de nom accessible — WCAG 2.2, critère 2.4.4. Ajouter un texte visible ou un aria-label.`,
    );
  }

  private judgeForms(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const fields = $(LABELLED_FIELDS).toArray();
    if (fields.length === 0) return;

    // Les `label[for]` sont indexés UNE FOIS. La v1 construisait un sélecteur
    // `label[for="${id}"]` à partir d'un identifiant venu de la page analysée :
    // un `id` contenant un guillemet ou un crochet y cassait le sélecteur, donc
    // le critère entier, sur une valeur que l'auteur de la page contrôle.
    const labelled = new Set<string>();
    $('label[for]').each((_, element) => {
      const target = $(element).attr('for');
      if (target) labelled.add(target);
    });

    const unlabelled = fields.filter(element => {
      const node = $(element);
      if (node.attr('aria-label')?.trim() || node.attr('aria-labelledby')?.trim()) return false;

      const id = node.attr('id');
      if (id && labelled.has(id)) return false;

      // Un `<label>Nom <input></label>` nomme son champ sans `for` : c'est du
      // HTML valide et très répandu, que la v1 comptait en défaut.
      return node.closest('label').length === 0;
    }).length;

    if (unlabelled === 0) {
      items.push({
        key: 'A11Y.form_labeled',
        label: `${fields.length} champ(s) de formulaire correctement étiqueté(s)`,
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'A11Y.form_no_label',
      label: `${unlabelled} champ(s) de formulaire sans étiquette`,
      status: 'fail',
    });
    recommendations.push(
      `${unlabelled} champ(s) n'ont pas de <label> associé — WCAG 2.2, critère 1.3.1.`,
    );
  }

  private judgeTabindex(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const positive = $('[tabindex]')
      .toArray()
      .filter(element => Number.parseInt($(element).attr('tabindex') ?? '0', 10) > 0).length;

    if (positive === 0) return;

    items.push({
      key: 'A11Y.tabindex_positive',
      label: `${positive} élément(s) avec tabindex > 0`,
      status: 'warning',
    });
    recommendations.push(
      'Éviter les tabindex positifs : ils imposent un ordre de tabulation qui diverge de l’ordre de lecture — WCAG 2.2, critère 2.4.3.',
    );
  }

  private judgeRoles(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const invalid = $('[role]')
      .toArray()
      .filter(element => {
        // Un `role` peut en lister plusieurs : le premier reconnu l'emporte,
        // comme dans les navigateurs.
        const roles = ($(element).attr('role') ?? '').split(/\s+/).filter(Boolean);
        return roles.length > 0 && !roles.some(role => VALID_ROLES.has(role));
      }).length;

    if (invalid === 0) return;

    items.push({
      key: 'A11Y.aria_invalid',
      label: `${invalid} rôle(s) ARIA invalide(s)`,
      status: 'warning',
    });
    recommendations.push(
      `${invalid} attribut(s) role portent une valeur hors du vocabulaire WAI-ARIA : ils sont ignorés par les technologies d'assistance.`,
    );
  }

  private judgeLang(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    if (page.$('html').attr('lang')?.trim()) return;

    items.push({
      key: 'A11Y.lang_missing',
      label: 'Attribut lang absent sur <html>',
      status: 'fail',
    });
    recommendations.push(
      'Définir l’attribut lang sur <html> — WCAG 2.2, critère 3.1.1 : un lecteur d’écran y choisit sa voix.',
    );
  }
}

/**
 * Barème repris de la v1.
 *
 * Trois défauts bloquants annulent la note : une page sans alt, sans nom de
 * lien et sans étiquette de formulaire est inutilisable au lecteur d'écran, et
 * la moyenne n'a plus à être nuancée.
 */
function accessibilityScore(failures: number, warnings: number): number {
  if (failures >= 3) return 0;
  if (failures === 2) return 1;
  if (failures === 1) return warnings >= 1 ? 2 : 3;
  if (warnings >= 3) return 3;
  if (warnings >= 1) return 4;
  return 5;
}
