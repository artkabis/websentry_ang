import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { truncateSource } from '../locate.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Numéro de téléphone acceptable dans un `tel:`.
 *
 * Deux formes : le national français, et l'international E.164. La v1
 * n'acceptait que `+33`, si bien qu'un numéro belge ou suisse parfaitement
 * valide était signalé comme une ERREUR — sur des sites qui en ont
 * légitimement.
 */
const PHONE_NATIONAL = /^0[1-9]\d{8}$/;
const PHONE_E164 = /^\+[1-9]\d{7,14}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Expressions qui signalent un appel à l'action dans un libellé de lien. */
const CTA_KEYWORDS = [
  'contact',
  'contactez',
  'appel',
  'appelez',
  'devis',
  'rdv',
  'rendez-vous',
  'réservation',
  'réserver',
  'demande',
  'inscription',
  'abonnez',
  'subscribe',
  'commandez',
  'acheter',
  'buy',
  'order',
  'call',
  'email',
  'envoyer',
  'send',
  'commencer',
  'démarrer',
  'start',
  'essai',
  'gratuit',
  'free',
  'en savoir plus',
  'learn more',
  'découvrir',
  'voir',
  'consulter',
];

/**
 * Expression construite une fois, avec des FRONTIÈRES de mot.
 *
 * La v1 testait l'inclusion brute : « voir » se retrouve dans « savoir »,
 * « pouvoir » et « recevoir », et n'importe quel lien contenant l'un de ces
 * mots était compté comme un appel à l'action. Le rapport annonçait des CTA
 * que la page n'avait pas.
 */
const CTA_PATTERN = new RegExp(
  `(?<![\\p{L}])(${CTA_KEYWORDS.map(escapeRegExp).join('|')})(?![\\p{L}])`,
  'iu',
);

/** Éléments qui tiennent lieu de contenu dans un bouton sans texte. */
const BUTTON_CONTENT =
  'img, svg, i, em, span[class*="icon"], span[class*="fa"], span[class*="material"]';

export class CtaAnalyzer extends BaseAnalyzer {
  readonly id = 'CTA';
  readonly title = "Appels à l'action (CTA)";

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const buttons = this.judgeButtons(page, items, recommendations);
    const links = this.judgeLinks(page, items);
    const phones = this.judgePhones(page, items, recommendations);
    const emails = this.judgeEmails(page, items, recommendations);

    const total = buttons + links.textual + links.visual + phones + emails;
    if (total === 0) {
      items.push({ key: 'CTA.no_cta', label: 'Aucun CTA détecté', status: 'fail' });
      recommendations.push(
        'La page ne contient aucun appel à l’action. Ajouter des boutons, un lien téléphone ou un lien email.',
      );
    }

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: ctaScore(failures, warnings),
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${buttons} bouton(s), ${phones} tel:, ${emails} mailto:, ${links.textual} lien(s) CTA.`,
      recommendations,
    });
  }

  private judgeButtons(page: HtmlPage, items: CheckItem[], recommendations: string[]): number {
    const { $ } = page;
    const buttons = $('button, [role="button"], input[type="submit"], input[type="button"]');

    items.push({
      key: 'CTA.button_count',
      label: `${buttons.length} bouton(s)`,
      status: buttons.length > 0 ? 'pass' : 'warning',
    });

    if (buttons.length === 0) {
      recommendations.push(
        'Aucun bouton d’action détecté. Ajouter des CTA explicites (« Contactez-nous », « Demander un devis »).',
      );
      return 0;
    }

    const empty = buttons.filter((_, element) => isEmptyButton($, element));
    if (empty.length > 0) {
      // `info` et non `warning` : un hamburger ou une flèche de carrousel n'a
      // pas de texte par nature. L'accessibilité relève du critère dédié.
      items.push({
        key: 'CTA.buttons_empty',
        label: `${empty.length} bouton(s) sans texte lisible`,
        status: 'info',
        detail: 'Boutons système (menu, carrousel…) — à vérifier côté accessibilité.',
        source: truncateSource($.html(empty.first())),
      });
    }

    return buttons.length;
  }

  private judgeLinks(page: HtmlPage, items: CheckItem[]): { textual: number; visual: number } {
    const { $ } = page;
    const textual: string[] = [];
    const visual: string[] = [];

    $('a').each((_, element) => {
      const node = $(element);
      const text = node.text().trim();

      if (!text) {
        if (!hasVisualContent($, element)) return;
        const alternative =
          node.find('img').attr('alt')?.trim() ||
          node.attr('aria-label')?.trim() ||
          node.attr('title')?.trim() ||
          '';
        visual.push(alternative || '(image sans alt)');
        return;
      }

      if (CTA_PATTERN.test(text)) textual.push(text.slice(0, 40));
    });

    if (textual.length > 0) {
      items.push({
        key: 'CTA.cta_links',
        label: `${textual.length} lien(s) CTA détecté(s)`,
        status: 'pass',
        detail: textual.slice(0, 5).join(', '),
      });
    }

    if (visual.length > 0) {
      items.push({
        key: 'CTA.image_links',
        label: `${visual.length} lien(s) image (CTA visuel)`,
        status: 'info',
        detail: visual.slice(0, 5).join(', '),
      });
    }

    return { textual: textual.length, visual: visual.length };
  }

  private judgePhones(page: HtmlPage, items: CheckItem[], recommendations: string[]): number {
    const { $ } = page;
    const links = $('a[href^="tel:"]');

    if (links.length === 0) {
      items.push({
        key: 'CTA.no_phone',
        label: 'Aucun lien téléphonique (tel:)',
        status: 'warning',
      });
      recommendations.push(
        'Ajouter un lien <a href="tel:0XXXXXXXXX"> pour faciliter le contact depuis un mobile.',
      );
      return 0;
    }

    let invalid = 0;
    links.each((_, element) => {
      const raw = ($(element).attr('href') ?? '').slice('tel:'.length).replace(/[\s.-]/g, '');
      if (!PHONE_NATIONAL.test(raw) && !PHONE_E164.test(raw)) invalid += 1;
    });

    items.push({
      key: 'CTA.phone_count',
      label: `${links.length} lien(s) téléphonique(s)${invalid > 0 ? ` (${invalid} invalide(s))` : ''}`,
      status: invalid > 0 ? 'fail' : 'pass',
    });
    if (invalid > 0) {
      recommendations.push(
        `${invalid} numéro(s) invalide(s) dans les liens tel: — format attendu 0XXXXXXXXX ou +33XXXXXXXXX.`,
      );
    }

    return links.length;
  }

  private judgeEmails(page: HtmlPage, items: CheckItem[], recommendations: string[]): number {
    const { $ } = page;
    const links = $('a[href^="mailto:"]');

    if (links.length === 0) {
      items.push({ key: 'CTA.no_email', label: 'Aucun lien email (mailto:)', status: 'warning' });
      return 0;
    }

    let invalid = 0;
    links.each((_, element) => {
      const href = $(element).attr('href') ?? '';
      // Un `mailto:` peut porter des paramètres (`?subject=…`) : seule la
      // partie qui précède compte comme adresse.
      const [address = ''] = href.slice('mailto:'.length).split('?');
      const decoded = safeDecode(address.trim());
      if (decoded && !EMAIL_PATTERN.test(decoded)) invalid += 1;
    });

    items.push({
      key: 'CTA.email_count',
      label: `${links.length} lien(s) email${invalid > 0 ? ` (${invalid} invalide(s))` : ''}`,
      status: invalid > 0 ? 'fail' : 'pass',
    });
    if (invalid > 0) {
      recommendations.push(`${invalid} adresse(s) invalide(s) dans les liens mailto:.`);
    }

    return links.length;
  }
}

function isEmptyButton($: HtmlPage['$'], element: Parameters<typeof $>[0]): boolean {
  const node = $(element);
  if (node.text().trim()) return false;
  for (const attribute of ['value', 'aria-label', 'aria-labelledby', 'title']) {
    if (node.attr(attribute)?.trim()) return false;
  }
  if (node.find(BUTTON_CONTENT).length > 0) return false;

  const style = node.attr('style') ?? '';
  return !style.includes('background-image') && !style.includes('background:');
}

/** Un lien sans texte reste un CTA s'il porte une image ou un fond. */
function hasVisualContent($: HtmlPage['$'], element: Parameters<typeof $>[0]): boolean {
  const node = $(element);
  if (node.find('img').length > 0) return true;

  const hasBackground = (style: string): boolean =>
    style.includes('background-image') || style.includes('background:');

  if (hasBackground(node.attr('style') ?? '')) return true;
  return node
    .children()
    .toArray()
    .some(child => hasBackground($(child).attr('style') ?? ''));
}

/** Une adresse peut être percent-encodée dans le href ; un encodage cassé n'est pas une adresse. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Barème repris de la v1 : deux échecs annulent la note.
 *
 * Un numéro ET une adresse invalides veulent dire qu'aucun moyen de contact de
 * la page ne fonctionne — le visiteur ne peut rien faire.
 */
function ctaScore(failures: number, warnings: number): number {
  if (failures >= 2) return 0;
  if (failures === 1) return 2;
  if (warnings >= 2) return 3;
  if (warnings === 1) return 4;
  return 5;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
