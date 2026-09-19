import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Familles d'icônes reconnues, par PRÉFIXE de classe.
 *
 * Le filtrage se fait sur des jetons de classe entiers. La v1 utilisait
 * `[class*="fa-"]`, qui capte tout attribut contenant la sous-chaîne : une
 * classe `sofa-image` y passait pour une icône Font Awesome, et gonflait le
 * décompte d'une page qui n'en contient aucune.
 */
const FONT_AWESOME_EXACT = new Set(['fa', 'fas', 'far', 'fab', 'fal', 'fad', 'fat']);
const MATERIAL_CLASSES = new Set([
  'material-icons',
  'material-icons-outlined',
  'material-icons-round',
  'material-symbols-outlined',
]);

export class PictogramAnalyzer extends BaseAnalyzer {
  readonly id = 'PICTOGRAM';
  readonly title = 'Pictogrammes & icônes';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const fontAwesome = this.judgeFontAwesome(page, items, recommendations);
    const material = countByClass(page, token => MATERIAL_CLASSES.has(token));
    const bootstrap = countByClass(page, token => token.startsWith('bi-'));
    const svg = this.judgeSvg(page, items, recommendations);

    if (material > 0) {
      items.push({
        key: 'PICTO.mi_count',
        label: `${material} Material Icon(s) détectée(s)`,
        status: 'pass',
      });
    }
    if (bootstrap > 0) {
      items.push({
        key: 'PICTO.bi_count',
        label: `${bootstrap} Bootstrap Icon(s) détectée(s)`,
        status: 'pass',
      });
    }

    const total = fontAwesome + material + bootstrap + svg;
    items.push(
      total === 0
        ? {
            key: 'PICTO.no_icons',
            label: 'Aucune icône ni pictogramme détecté',
            status: 'pass',
            detail: 'Rien à signaler.',
          }
        : {
            key: 'PICTO.total',
            label: `${total} icône(s) / pictogramme(s) au total`,
            status: 'pass',
          },
    );

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures > 0 ? 1 : warnings >= 2 ? 3 : warnings === 1 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${fontAwesome} Font Awesome, ${material} Material, ${bootstrap} Bootstrap, ${svg} SVG en ligne.`,
      recommendations,
    });
  }

  private judgeFontAwesome(page: HtmlPage, items: CheckItem[], recommendations: string[]): number {
    const { $ } = page;
    const icons = page
      .$('[class]')
      .toArray()
      .filter(element =>
        classTokens($(element).attr('class')).some(
          token => token.startsWith('fa-') || FONT_AWESOME_EXACT.has(token),
        ),
      );

    if (icons.length === 0) return 0;

    items.push({
      key: 'PICTO.fa_count',
      label: `${icons.length} icône(s) Font Awesome détectée(s)`,
      status: 'pass',
    });

    const inaccessible = icons.filter(element => !hasAccessibleContext($, element)).length;
    if (inaccessible > 0) {
      items.push({
        key: 'PICTO.fa_accessibility',
        label: `${inaccessible} icône(s) Font Awesome sans alternative accessible`,
        status: 'warning',
        detail: 'Ajouter aria-label, ou aria-hidden="true" sur les icônes décoratives.',
      });
      recommendations.push(
        `${inaccessible} icône(s) Font Awesome n’ont ni libellé ni texte voisin. Ajouter aria-hidden="true" si elles sont décoratives.`,
      );
    }

    if (!isLibraryLoaded(page)) {
      items.push({
        key: 'PICTO.fa_not_loaded',
        label: 'Classes Font Awesome présentes sans bibliothèque chargée',
        status: 'warning',
      });
      recommendations.push(
        'Des classes Font Awesome sont utilisées mais aucune feuille de style ni script ne semble charger la bibliothèque.',
      );
    }

    return icons.length;
  }

  private judgeSvg(page: HtmlPage, items: CheckItem[], recommendations: string[]): number {
    const { $ } = page;
    const svgs = $('svg');
    if (svgs.length === 0) return 0;

    items.push({ key: 'PICTO.svg_count', label: `${svgs.length} SVG en ligne`, status: 'pass' });

    let unlabelled = 0;
    svgs.each((_, element) => {
      const node = $(element);
      const decorative =
        node.attr('aria-hidden') === 'true' || node.attr('role') === 'presentation';
      const labelled =
        node.find('title').length > 0 || node.attr('aria-label') || node.attr('aria-labelledby');
      if (!decorative && !labelled) unlabelled += 1;
    });

    if (unlabelled > 0) {
      items.push({
        key: 'PICTO.svg_accessibility',
        label: `${unlabelled} SVG sans titre ni aria-hidden`,
        status: 'warning',
        detail:
          'SVG significatif : ajouter <title> ou aria-label. SVG décoratif : aria-hidden="true".',
      });
      recommendations.push(
        `${unlabelled} SVG en ligne ne sont pas accessibles. Ajouter <title> ou aria-hidden="true".`,
      );
    }

    return svgs.length;
  }
}

/**
 * L'icône est-elle intelligible ?
 *
 * Elle l'est si elle porte un attribut d'accessibilité, ou si du texte
 * l'accompagne. La v1 comparait au texte du PARENT — lequel contient l'icône
 * elle-même et, sur une page réelle, n'est presque jamais vide : le contrôle ne
 * se déclenchait donc jamais. On retire ici le texte de l'icône de celui de son
 * parent avant de conclure.
 */
function hasAccessibleContext($: HtmlPage['$'], element: Parameters<HtmlPage['$']>[0]): boolean {
  const node = $(element);
  if (node.attr('aria-label') ?? node.attr('aria-hidden') ?? node.attr('title')) return true;

  const own = node.text().trim();
  const parentText = node.parent().text().trim();
  return parentText.replace(own, '').trim().length > 0;
}

/** Compte les éléments dont UN JETON de classe satisfait le prédicat. */
function countByClass(page: HtmlPage, matches: (token: string) => boolean): number {
  const { $ } = page;
  return $('[class]')
    .toArray()
    .filter(element => classTokens($(element).attr('class')).some(matches)).length;
}

function classTokens(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

/**
 * La bibliothèque d'icônes est-elle réellement chargée ?
 *
 * On regarde les feuilles de style et les scripts, pas le document entier : le
 * nom « fontawesome » dans un commentaire ou un texte ne charge rien.
 */
function isLibraryLoaded(page: HtmlPage): boolean {
  const { $ } = page;
  const sources: string[] = [];

  $('link[href]').each((_, element) => {
    sources.push($(element).attr('href') ?? '');
  });
  $('script[src]').each((_, element) => {
    sources.push($(element).attr('src') ?? '');
  });
  $('style').each((_, element) => {
    sources.push($(element).html() ?? '');
  });

  return /font-?awesome|kit\.fontawesome\.com/i.test(sources.join('\n'));
}
