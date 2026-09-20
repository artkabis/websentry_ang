import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { NetworkProbe } from '../network-probe.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Mentions légales et obligations RGPD.
 *
 * Trois documents sont cherchés dans les liens de la page, puis la page de
 * mentions légales est RÉELLEMENT ouverte pour y chercher l'hébergeur — qu'il
 * soit obligatoire en droit français ne suffit pas à le rendre présent.
 */

/**
 * Libellés et chemins reconnus, par document.
 *
 * L'ordre compte : un lien est attribué au PREMIER document qu'il satisfait,
 * et les mentions légales passent en dernier. La v1 les testait en premier
 * avec le mot-clé « legal », si bien qu'un lien `/legal/confidentialite`
 * devenait les mentions légales et que la politique de confidentialité était
 * ensuite portée manquante.
 */
const PRIVACY_HINTS = [
  'confidentialité',
  'confidentialite',
  'politique de confidentialité',
  'privacy',
  'données personnelles',
  'donnees-personnelles',
  'rgpd',
  'gdpr',
  'protection des données',
  'vie privée',
  'vie-privee',
  'vie privee',
];

const TERMS_HINTS = [
  'conditions générales',
  'conditions generales',
  'cgu',
  'cgv',
  'terms',
  "conditions d'utilisation",
  'conditions-utilisation',
];

const LEGAL_HINTS = [
  'mentions légales',
  'mentions-légales',
  'mentions legales',
  'mentions-legales',
  'notice légale',
  'legal-notice',
  'mentions',
  'legal',
  'légal',
];

/** Signatures d'une solution de consentement dans la page. */
const CONSENT_SIGNATURES: readonly RegExp[] = [
  /cookiebot/i,
  /onetrust|optanon/i,
  /axeptio/i,
  /tarteaucitron/i,
  /cookie-?consent/i,
  /didomi/i,
  /accepter[^.]{0,20}cookies?/i,
  /nous utilisons des cookies/i,
];

/** Mentions qui valent déclaration d'hébergeur. */
const HOSTING_PATTERN =
  /hébergeur|héberge(?:ur|ment|é)|hosted by|\bovh\b|infomaniak|ionos|amazon web services|aws\.amazon|\bazure\b|google cloud|scaleway|hetzner|gandi/i;

/** Plafond de lecture de la page de mentions légales. */
const LEGAL_PAGE_BYTES = 512 * 1024;

type DocumentKind = 'privacy' | 'terms' | 'legal';

export class MentionsLegalesAnalyzer extends BaseAnalyzer {
  readonly id = 'MENTIONS_LEGALES';
  readonly title = 'Mentions légales & RGPD';

  async analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return this.na();

    const items: CheckItem[] = [];
    const recommendations: string[] = [];
    const found = collectDocuments(page);

    await this.judgeLegal(found.legal, page, net, items, recommendations);
    this.judgePrivacy(found.privacy, items, recommendations);
    this.judgeTerms(found.terms, items);
    this.judgeLegacyWidget(page, items, recommendations);
    const consent = this.judgeConsent(page, items, recommendations);
    await this.judgeHosting(found.legal, page, net, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore:
        failures >= 2 ? 0 : failures === 1 ? 2 : warnings >= 2 ? 3 : warnings === 1 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `Mentions légales : ${found.legal ? 'présentes' : 'absentes'} — confidentialité : ${
        found.privacy ? 'présente' : 'absente'
      } — consentement : ${consent ? 'présent' : 'absent'}.`,
      recommendations,
    };
  }

  private async judgeLegal(
    href: string | null,
    page: HtmlPage,
    net: NetworkProbe | undefined,
    items: CheckItem[],
    recommendations: string[],
  ): Promise<void> {
    if (!href) {
      items.push({
        key: 'ML.legal_missing',
        label: 'Lien vers les mentions légales non trouvé',
        status: 'fail',
      });
      recommendations.push(
        'Ajouter un lien vers les mentions légales : elles sont obligatoires pour tout site professionnel en France.',
      );
      return;
    }

    items.push({ key: 'ML.legal_ok', label: `Mentions légales : ${href}`, status: 'pass' });

    const target = absolute(href, page.url);
    if (!target || !net) return;

    const result = await net.check(target);
    if (result.ok) {
      items.push({
        key: 'ML.legal_inaccessible',
        label: 'Lien mentions légales accessible',
        status: 'pass',
      });
      return;
    }

    if (result.exhausted) {
      // Quota atteint : le lien n'a pas été interrogé. Le déclarer mort
      // reprocherait au site une limite qui est la nôtre.
      items.push({
        label: 'Lien mentions légales non vérifié — quota de requêtes atteint',
        status: 'info',
      });
      return;
    }

    // Un lien présent mais mort vaut une absence : le visiteur n'atteint pas
    // le document, et l'obligation n'est pas remplie pour autant.
    items.push({
      key: 'ML.legal_inaccessible',
      label: `Lien mentions légales inaccessible${result.status ? ` (${result.status})` : ''}`,
      status: 'fail',
      detail: result.error,
    });
    recommendations.push('Le lien vers les mentions légales ne mène à aucune page valide.');
  }

  private judgePrivacy(href: string | null, items: CheckItem[], recommendations: string[]): void {
    if (href) {
      items.push({ key: 'ML.privacy_ok', label: `Confidentialité : ${href}`, status: 'pass' });
      return;
    }

    items.push({
      key: 'ML.privacy_missing',
      label: 'Politique de confidentialité non trouvée',
      status: 'warning',
    });
    recommendations.push(
      'Ajouter un lien vers la politique de confidentialité — exigée par le RGPD dès qu’il y a collecte de données.',
    );
  }

  private judgeTerms(href: string | null, items: CheckItem[]): void {
    items.push(
      href
        ? { key: 'ML.cgu_ok', label: `CGU/CGV : ${href}`, status: 'pass' }
        : {
            key: 'ML.cgu_missing',
            label: 'CGU/CGV non trouvées',
            // Pas un défaut : sans vente en ligne, elles ne sont pas exigées.
            status: 'pass',
            detail: 'Non obligatoires en l’absence de vente en ligne.',
          },
    );
  }

  /** Ancien widget RGPD de l'éditeur : obsolète, et non conforme aujourd'hui. */
  private judgeLegacyWidget(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const isEditorPage =
      page.html.includes('window.Parameters') || page.html.includes('dmFooterContainer');
    if (!isEditorPage) return;

    if (!page.$('.dmFooterContainer').text().toLowerCase().includes('solocal')) {
      items.push({
        key: 'ML.solocal_ok',
        label: 'Ancien widget RGPD de l’éditeur non détecté',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'ML.solocal_detected',
      label: 'Ancien widget RGPD (Solocal) détecté dans le pied de page',
      status: 'fail',
      detail: 'Ce widget est obsolète et ne recueille pas un consentement conforme.',
    });
    recommendations.push(
      'Retirer l’ancien widget RGPD du pied de page et le remplacer par une solution de consentement conforme.',
    );
  }

  private judgeConsent(page: HtmlPage, items: CheckItem[], recommendations: string[]): boolean {
    const present = CONSENT_SIGNATURES.some(pattern => pattern.test(page.html));

    if (present) {
      items.push({
        key: 'ML.cookie_ok',
        label: 'Bandeau de consentement cookies présent',
        status: 'pass',
      });
      return true;
    }

    items.push({
      key: 'ML.cookie_missing',
      label: 'Bandeau de consentement cookies non détecté',
      status: 'warning',
    });
    recommendations.push(
      'Un bandeau de consentement est obligatoire dès qu’un cookie non essentiel est déposé (RGPD / ePrivacy).',
    );
    return present;
  }

  /**
   * L'hébergeur est-il déclaré ?
   *
   * On lit la page de mentions légales elle-même. La v1 se rabattait
   * SILENCIEUSEMENT sur la page courante quand la lecture échouait : un site
   * dont une page mentionne « OVH » ailleurs était déclaré conforme sans que
   * rien n'ait été vérifié. Ici, une lecture impossible se DIT.
   */
  private async judgeHosting(
    legalHref: string | null,
    page: HtmlPage,
    net: NetworkProbe | undefined,
    items: CheckItem[],
    recommendations: string[],
  ): Promise<void> {
    const target = legalHref ? absolute(legalHref, page.url) : null;
    let source = page.html;
    let verifiedOnLegalPage = false;

    if (target && net) {
      const { result, body } = await net.fetchText(target, LEGAL_PAGE_BYTES);
      if (result.ok && body) {
        source = body;
        verifiedOnLegalPage = true;
      }
    }

    const declared = HOSTING_PATTERN.test(source);

    if (declared) {
      items.push({
        key: 'ML.hosting_ok',
        label: verifiedOnLegalPage
          ? 'Hébergeur mentionné dans les mentions légales'
          : 'Hébergeur mentionné sur la page analysée',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'ML.hosting_missing',
      label: verifiedOnLegalPage
        ? 'Hébergeur non mentionné dans les mentions légales'
        : 'Hébergeur non mentionné (page de mentions légales non lue)',
      status: 'warning',
      detail:
        'Le droit français impose d’indiquer le nom, l’adresse et les coordonnées de l’hébergeur.',
    });
    recommendations.push(
      'Compléter les mentions légales avec le nom, l’adresse et les coordonnées de l’hébergeur.',
    );
  }
}

/** Premier lien trouvé pour chaque document — un lien ne sert qu'une fois. */
function collectDocuments(page: HtmlPage): Record<DocumentKind, string | null> {
  const { $ } = page;
  const found: Record<DocumentKind, string | null> = { privacy: null, terms: null, legal: null };

  $('a[href]').each((_, element) => {
    const node = $(element);
    const href = node.attr('href') ?? '';
    const haystack = `${node.text()} ${href}`.toLowerCase();

    const kind = classify(haystack);
    if (kind && !found[kind]) found[kind] = href;
  });

  return found;
}

/** Classement du plus SPÉCIFIQUE au plus général — voir le commentaire des listes. */
function classify(haystack: string): DocumentKind | null {
  if (PRIVACY_HINTS.some(hint => haystack.includes(hint))) return 'privacy';
  if (TERMS_HINTS.some(hint => haystack.includes(hint))) return 'terms';
  if (LEGAL_HINTS.some(hint => haystack.includes(hint))) return 'legal';
  return null;
}

function absolute(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}
