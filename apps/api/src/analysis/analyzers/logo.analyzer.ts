import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { truncateSource } from '../locate.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Où chercher le logo, du plus spécifique au plus large.
 *
 * L'ordre est significatif : les sélecteurs Duda passent en premier pour ne
 * pas confondre le logo avec un drapeau de langue, qui vit dans le même
 * en-tête.
 */
const LOGO_SELECTORS: readonly string[] = [
  '[data-widget-type="logo"] img',
  '.dmLogo img',
  '[class*="dmLogo"] img',
  'header [class*="logo"] img',
  'header [id*="logo"] img',
  '[class*="hfcontainer"] [class*="logo"] img',
  '[class*="hfcontainer"] [id*="logo"] img',
  '.hamburger-header img',
  'nav [class*="logo"] img',
  '[class*="header"] [class*="logo"] img',
  '[class*="hfcontainer"] img',
  '[class*="logo"] img',
  '[id*="logo"] img',
  'header a img',
  'header img',
];

/** Conteneurs qui n'abritent jamais un logo — drapeaux, réseaux sociaux, CTA. */
const EXCLUDED_ANCESTORS: readonly string[] = [
  '[data-element-type="language"]',
  '[class*="language"]',
  '[id*="language"]',
  '[class*="lang-"]',
  '[id*="lang-"]',
  '.dmSocialHub',
  '[data-widget-type="social"]',
  '[data-element-type="clicktocall"]',
  '[data-element-type="clicktomail"]',
  '[class*="flag"]',
  '[id*="flag"]',
  'nav [data-widget-type]:not([data-widget-type="logo"])',
];

/** Paramètres que Duda injecte en mode aperçu et qui ne font pas partie de l'URL. */
const PREVIEW_PARAMS = ['preview', 'insitepreview', 'dm_device'];

export class LogoAnalyzer extends BaseAnalyzer {
  readonly id = 'LOGO';
  readonly title = "Logo dans l'en-tête";

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const logo = findLogo(page);
    if (!logo) {
      return Promise.resolve(
        this.fail(
          [{ key: 'LOGO.not_found', label: 'Logo non trouvé dans l’en-tête', status: 'fail' }],
          'Aucun logo détecté dans l’en-tête de la page.',
          ['Ajouter un logo dans le <header>, en <img>, encapsulé dans un lien vers l’accueil.'],
        ),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];
    const source = truncateSource(page.$.html(logo));

    this.judgeAlt(logo, source, items, recommendations);
    this.judgeLink(logo, page, items, recommendations);
    this.judgeSrc(logo, page, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: logoScore(failures, warnings),
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: 'Logo analysé.',
      recommendations,
    });
  }

  private judgeAlt(
    logo: Selection,
    source: string | undefined,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const alt = logo.attr('alt');

    if (alt === undefined) {
      items.push({
        key: 'LOGO.alt_missing',
        label: 'Logo sans attribut alt',
        status: 'fail',
        source,
      });
      recommendations.push('Ajouter un attribut alt au logo (par exemple le nom de l’entreprise).');
      return;
    }

    if (alt.trim() === '') {
      // Un `alt` vide déclare une image DÉCORATIVE. Le logo porte le nom de la
      // marque : le déclarer décoratif le retire de la restitution vocale.
      items.push({
        key: 'LOGO.alt_empty',
        label: 'Logo sans texte alternatif (alt vide)',
        status: 'fail',
        detail: 'Le logo doit décrire la marque : un alt vide le déclare purement décoratif.',
        source,
      });
      recommendations.push('Renseigner l’alt du logo avec le nom de la marque ou de l’entreprise.');
      return;
    }

    items.push({ key: 'LOGO.alt_ok', label: `Logo alt : « ${alt} »`, status: 'pass', source });
  }

  private judgeLink(
    logo: Selection,
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const link = logo.closest('a');

    if (link.length === 0) {
      items.push({ key: 'LOGO.not_clickable', label: 'Logo non cliquable', status: 'warning' });
      recommendations.push('Encapsuler le logo dans un lien <a href="/"> vers l’accueil.');
      return;
    }

    const href = link.attr('href') ?? '';
    if (!href) {
      items.push({ key: 'LOGO.link_no_href', label: 'Lien du logo sans href', status: 'warning' });
      recommendations.push('Le lien du logo n’a pas de href : le faire pointer vers l’accueil.');
    } else if (isHomepage(href, page.url)) {
      items.push({ key: 'LOGO.link_homepage', label: 'Logo lié à l’accueil', status: 'pass' });
    } else if (isSameHost(href, page.url)) {
      items.push({
        key: 'LOGO.link_other_page',
        label: `Logo lié à : ${href}`,
        status: 'warning',
        detail: 'Ce n’est pas la page d’accueil.',
      });
      recommendations.push('Le logo devrait pointer vers la page d’accueil.');
    } else {
      items.push({
        key: 'LOGO.link_external',
        label: 'Logo lié à un domaine externe',
        status: 'warning',
        value: href,
      });
      recommendations.push('Le lien du logo pointe vers un domaine externe.');
    }

    const title = logo.attr('title') ?? '';
    if (title.toLowerCase().includes('accueil')) {
      items.push({
        key: 'LOGO.link_title_ok',
        label: `Title de l’image du logo : « ${title} »`,
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'LOGO.link_title_missing',
      label: title
        ? `Title de l’image du logo : « ${title} » — devrait contenir « accueil »`
        : 'Title de l’image du logo absent — devrait contenir « accueil »',
      status: 'warning',
    });
    recommendations.push('Ajouter title="Accueil" sur l’image du logo pour l’infobulle.');
  }

  private judgeSrc(
    logo: Selection,
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    // `data-src` et `data-dm-image-path` couvrent le chargement différé : une
    // image différée a bien une source, simplement pas encore dans `src`.
    const src = logo.attr('src') ?? logo.attr('data-src') ?? logo.attr('data-dm-image-path') ?? '';

    if (!src) {
      items.push({ key: 'LOGO.src_missing', label: 'Logo sans src', status: 'fail' });
      recommendations.push('L’image du logo n’a pas d’attribut src.');
      return;
    }

    items.push({
      key: 'LOGO.src_ok',
      label: `Logo src : ${fileNameOf(src, page.url)}`,
      status: 'pass',
      value: src,
    });
  }
}

function findLogo(page: HtmlPage): Selection | null {
  const { $ } = page;

  for (const selector of LOGO_SELECTORS) {
    for (const element of $(selector).toArray()) {
      const excluded = EXCLUDED_ANCESTORS.some(ancestor => $(element).closest(ancestor).length > 0);
      if (!excluded) return $(element);
    }
  }

  return null;
}

/**
 * Le lien mène-t-il à l'accueil ?
 *
 * Deux cas particuliers de Duda : en aperçu, le href du logo porte le chemin
 * de la page courante au lieu de `/` ; et la racine d'un site en aperçu est un
 * chemin `/site/{hash}/`. Les ignorer ferait signaler « logo mal lié » sur tout
 * site consulté depuis l'éditeur.
 */
function isHomepage(href: string, pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const link = new URL(href, pageUrl);
    if (link.hostname !== page.hostname) return false;

    const pageInPreview = page.searchParams.get('insitepreview') === 'true';
    const linkInPreview =
      link.searchParams.get('insitepreview') === 'true' ||
      link.searchParams.get('preview') === 'true';
    if (pageInPreview && linkInPreview) return true;

    const path = stripPreviewParams(link).pathname;
    if (path === '/' || path === '') return true;

    const dudaRoot = /^(\/site\/[a-f0-9]+)\//.exec(page.pathname)?.[1];
    return dudaRoot ? path === `${dudaRoot}/` || path === dudaRoot : false;
  } catch {
    return false;
  }
}

function isSameHost(href: string, pageUrl: string): boolean {
  try {
    return new URL(href, pageUrl).hostname === new URL(pageUrl).hostname;
  } catch {
    return false;
  }
}

function stripPreviewParams(url: URL): URL {
  const clean = new URL(url.toString());
  for (const param of PREVIEW_PARAMS) clean.searchParams.delete(param);
  return clean;
}

/** Nom de fichier seul — une URL de CDN avec trente paramètres n'apprend rien. */
function fileNameOf(src: string, pageUrl: string): string {
  try {
    return new URL(src, pageUrl).pathname.split('/').pop() || src;
  } catch {
    return src.split('/').pop() ?? src;
  }
}

/** Barème repris de la v1 : les avertissements s'accumulent par palier. */
function logoScore(failures: number, warnings: number): number {
  if (failures > 0) return 1;
  if (warnings >= 3) return 2;
  if (warnings >= 2) return 3;
  if (warnings === 1) return 4;
  return 5;
}
