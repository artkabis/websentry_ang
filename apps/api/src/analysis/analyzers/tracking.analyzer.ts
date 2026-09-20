import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Outils de mesure reconnus, par signature dans le code exécuté.
 *
 * Les motifs visent du JavaScript ou une URL de script, jamais de la prose :
 * voir §« surface analysée » plus bas.
 */
const TRACKERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Google Analytics 4 (gtag.js)', pattern: /gtag\s*\(|googletagmanager\.com\/gtag/i },
  { name: 'Google Tag Manager', pattern: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/ },
  {
    name: 'Google Analytics UA (analytics.js)',
    pattern: /google-analytics\.com\/analytics\.js|ga\s*\(\s*['"]create['"]/i,
  },
  { name: 'Matomo / Piwik', pattern: /matomo\.js|piwik\.js|_paq\.push/i },
  { name: 'Facebook Pixel', pattern: /fbq\s*\(|connect\.facebook\.net[^"']*fbevents\.js/i },
  { name: 'LinkedIn Insight', pattern: /snap\.licdn\.com|_linkedin_partner_id/i },
  { name: 'Hotjar', pattern: /static\.hotjar\.com|hjid\s*[:=]/i },
  { name: 'Clarity (Microsoft)', pattern: /clarity\.ms/i },
  { name: 'Hubspot', pattern: /js\.hs-scripts\.com|js\.hsforms\.net/i },
  { name: 'Intercom', pattern: /widget\.intercom\.io|intercomSettings/i },
  { name: 'Crisp Chat', pattern: /client\.crisp\.chat|CRISP_WEBSITE_ID/i },
  { name: 'Tawk.to', pattern: /embed\.tawk\.to|Tawk_API/i },
];

/**
 * Signatures d'une plateforme de consentement.
 *
 * Elles aussi visent le code : une solution de consentement est un script, pas
 * un paragraphe. Voir §« surface analysée ».
 */
const CONSENT_SIGNATURES: readonly RegExp[] = [
  /cookiebot/i,
  /onetrust|optanon/i,
  /axeptio/i,
  /tarteaucitron/i,
  /cookieconsent/i,
  /cookie-?notice/i,
  /didomi/i,
  /klaro/i,
  /osano/i,
  /consentmanager/i,
  /__tcfapi/,
];

/** Éléments qu'une bannière de consentement laisse dans le DOM. */
const CONSENT_SELECTORS = [
  '#tarteaucitron',
  '#tarteaucitronRoot',
  '#axeptio_overlay',
  '#axeptio_main_button',
  '#CybotCookiebotDialog',
  '#onetrust-banner-sdk',
  '#didomi-host',
  '.cc-window',
  '[id*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[data-cookieconsent]',
].join(',');

export class TrackingAnalyzer extends BaseAnalyzer {
  readonly id = 'TRACKING';
  readonly title = 'Scripts de tracking & analytics';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const executable = collectExecutable(page);
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const detected = TRACKERS.filter(({ pattern }) => pattern.test(executable));
    for (const { name } of detected) {
      items.push({ key: 'TRACKING.tool_detected', label: name, status: 'pass' });
    }

    if (detected.length === 0) {
      items.push({
        key: 'TRACKING.none',
        label: 'Aucun outil de tracking détecté',
        status: 'warning',
      });
      recommendations.push(
        'Aucun outil de mesure détecté. Installer Google Analytics 4 ou Matomo pour suivre les performances du site.',
      );
    } else {
      items.push({
        key: 'TRACKING.count',
        label: `${detected.length} outil(s) de tracking détecté(s)`,
        status: 'pass',
      });
    }

    const hasConsent = detectConsent(page, executable);
    this.judgeConsent(hasConsent, detected.length, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures > 0 ? 1 : warnings > 0 ? 3 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${detected.length} traceur(s) détecté(s). ${hasConsent ? 'Consentement présent.' : 'Aucun consentement détecté.'}`,
      recommendations,
    });
  }

  /**
   * Des traceurs sans consentement sont un manquement RGPD, donc un échec.
   * Sans traceur, l'absence de bandeau n'est pas un défaut : il n'y a rien à
   * consentir.
   */
  private judgeConsent(
    hasConsent: boolean,
    trackerCount: number,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (hasConsent) {
      items.push({
        key: 'TRACKING.cmp_ok',
        label: 'Solution de consentement cookies détectée',
        status: 'pass',
      });
      return;
    }

    if (trackerCount === 0) return;

    items.push({
      key: 'TRACKING.no_cmp',
      label: 'Aucun bandeau de consentement cookies RGPD détecté',
      status: 'fail',
    });
    recommendations.push(
      'Des traceurs sont présents sans solution de consentement. Installer Axeptio, Tarteaucitron, Cookiebot ou équivalent.',
    );
  }
}

/**
 * §Surface analysée — le code exécuté, JAMAIS le texte visible.
 *
 * La v1 cherchait ses motifs dans le document ENTIER. Un site sans bandeau de
 * consentement mais dont le pied de page porte un lien « Politique RGPD »
 * satisfaisait donc le motif `/rgpd/i` et était déclaré conforme : le critère
 * annonçait l'inverse de la réalité, précisément sur le point qui engage
 * juridiquement l'éditeur. On ne lit plus que ce qui s'exécute — sources de
 * scripts, scripts en ligne, `iframe` et `link` — auxquels s'ajoute une
 * recherche par SÉLECTEUR pour les bannières qui se signalent dans le DOM.
 */
function collectExecutable(page: HtmlPage): string {
  const { $ } = page;
  const parts: string[] = [];

  $('script').each((_, element) => {
    const src = $(element).attr('src');
    if (src) parts.push(src);
    const inline = $(element).html();
    if (inline) parts.push(inline);
  });

  $('iframe[src], link[href]').each((_, element) => {
    parts.push($(element).attr('src') ?? $(element).attr('href') ?? '');
  });

  return parts.join('\n');
}

function detectConsent(page: HtmlPage, executable: string): boolean {
  if (CONSENT_SIGNATURES.some(pattern => pattern.test(executable))) return true;
  return page.$(CONSENT_SELECTORS).length > 0;
}
