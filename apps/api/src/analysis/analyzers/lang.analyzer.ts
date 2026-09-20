import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';
import { verdictOf } from '../verdict.js';

/**
 * Codes de langue courants.
 *
 * La liste ne sert PAS à valider — BCP 47 en autorise des milliers — mais à
 * repérer une valeur suspecte, du type `lang="français"` ou `lang="fr_FR"`.
 * D'où le statut « avertissement » et non « échec » quand un code en sort.
 */
const COMMON_LANGS = new Set([
  'fr',
  'fr-fr',
  'fr-be',
  'fr-ch',
  'fr-ca',
  'en',
  'en-us',
  'en-gb',
  'en-au',
  'en-ca',
  'de',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ja',
  'zh',
  'zh-cn',
  'zh-tw',
  'ar',
  'ko',
]);

export class LangAnalyzer extends BaseAnalyzer {
  readonly id = 'LANG';
  readonly title = 'Langue de la page';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const htmlLang = ($('html').attr('lang') ?? '').trim().toLowerCase();
    this.checkHtmlLang(htmlLang, items, recommendations);
    this.checkContentLanguage($, htmlLang, items, recommendations);
    this.checkHreflang($, items, recommendations);

    if (($('html').attr('dir') ?? '').toLowerCase() === 'rtl') {
      items.push({
        key: 'LANG.rtl',
        label: 'Direction RTL détectée',
        status: 'pass',
        detail: 'dir="rtl" sur <html>',
      });
    }

    const verdict = verdictOf(items);
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: verdict.globalScore,
      status: verdict.status,
      items,
      summary: `Langue : ${htmlLang || '(non définie)'}`,
      recommendations,
    });
  }

  private checkHtmlLang(htmlLang: string, items: CheckItem[], recommendations: string[]): void {
    if (!htmlLang) {
      items.push({
        key: 'LANG.missing',
        label: 'Attribut lang manquant sur <html>',
        status: 'fail',
      });
      recommendations.push(
        'Ajouter l’attribut lang à la balise <html> — un lecteur d’écran choisit sa voix dessus.',
      );
      return;
    }

    const base = htmlLang.split('-')[0] ?? '';
    if (!COMMON_LANGS.has(htmlLang) && !COMMON_LANGS.has(base)) {
      items.push({
        key: 'LANG.unusual',
        label: `lang="${htmlLang}" — code inhabituel`,
        status: 'warning',
      });
      recommendations.push(`Vérifier que « ${htmlLang} » est un code BCP 47 valide.`);
      return;
    }

    items.push({ key: 'LANG.ok', label: `lang="${htmlLang}"`, status: 'pass' });
  }

  private checkContentLanguage(
    $: HtmlPage['$'],
    htmlLang: string,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const contentLanguage = ($('meta[http-equiv="Content-Language"]').attr('content') ?? '')
      .trim()
      .toLowerCase();
    if (!contentLanguage) return;

    items.push({
      key: 'LANG.content_language',
      label: `Meta Content-Language : ${contentLanguage}`,
      status: 'pass',
    });

    const base = htmlLang.split('-')[0] ?? '';
    if (htmlLang && base && !contentLanguage.includes(base)) {
      items.push({
        key: 'LANG.lang_mismatch',
        label: 'Incohérence entre lang et Content-Language',
        status: 'warning',
      });
      recommendations.push(
        `<html lang="${htmlLang}"> et Content-Language « ${contentLanguage} » se contredisent.`,
      );
    }
  }

  private checkHreflang($: HtmlPage['$'], items: CheckItem[], recommendations: string[]): void {
    const links = $('link[rel="alternate"][hreflang]');
    if (links.length === 0) return;

    items.push({
      key: 'LANG.hreflang_count',
      label: `${links.length} lien(s) hreflang`,
      status: 'pass',
    });

    let hasDefault = false;
    links.each((_, element) => {
      if ($(element).attr('hreflang') === 'x-default') hasDefault = true;
    });

    if (!hasDefault) {
      items.push({
        key: 'LANG.hreflang_no_default',
        label: 'hreflang x-default manquant',
        status: 'warning',
      });
      recommendations.push(
        'Ajouter hreflang="x-default" : sans lui, le moteur choisit seul la version servie aux langues non couvertes.',
      );
    }
  }
}
