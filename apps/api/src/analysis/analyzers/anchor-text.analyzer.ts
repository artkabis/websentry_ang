import type { CheckItem, CheckResult, CheckStatus } from '@websentry/shared';
import {
  GENERIC_ANCHORS,
  SHOP_PATH_SEGMENTS,
  STOPWORDS,
  bestTokenScore,
  categoryBonus,
  companyNameTokens,
  computeFBetaScore,
  expandedTokens,
  hrefSegments,
  isAboutUrl,
  isAddressAnchor,
  isContactOrLocationUrl,
  isEmailAnchor,
  isPhoneAnchor,
  isShopLink,
  normalize,
  stem,
  tokenVsSegment,
  tokenize,
} from '../anchor-text.scoring.js';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText, truncateSource } from '../locate.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Concordance entre le texte d'un lien et l'URL qu'il vise.
 *
 * Une ancre « cliquez ici » ne dit rien de sa destination, ni au visiteur qui
 * l'entend lue par un lecteur d'écran, ni au moteur qui l'indexe. Le critère
 * mesure à quel point le texte annonce la page visée — en tolérant les
 * variations de langue, d'où le passage par racinisation et phonétique.
 */

/** Au-delà, ce n'est plus une ancre mais un paragraphe cliquable. */
const MAX_ANCHOR_LENGTH = 120;
/** Longueur minimale d'un mot pris en compte dans le test « tout mots-outils ». */
const MIN_SIGNIFICANT_WORD = 3;
/** Fraction de liens discordants au-delà de laquelle le critère ÉCHOUE. */
const FAILURE_RATIO = 0.3;

/** Score attribué par le pré-classifieur, court-circuitant le calcul. */
const PRECLASSIFIED_SCORE = 0.9;
const PARTIAL_COMPANY_SCORE = 0.8;

/** Promotion d'un token dominant : seuils de couverture. */
const DOMINANT_CONCORDANT = 0.9;
const DOMINANT_PROBABLE = 0.85;
const SEGMENT_COVERED = 0.6;

type Level = 'concordant' | 'probable' | 'ambiguous' | 'discordant' | 'generic';

interface LinkVerdict {
  anchor: string;
  href: string;
  level: Level;
  score: number;
  tokens: string[];
  segments: string[];
  /** Part des mots de l'ancre qui se retrouvent dans l'URL. */
  precision: number;
  /** Part des segments d'URL couverts par l'ancre. */
  recall: number;
  note?: string;
  source?: string;
}

interface Thresholds {
  concordant: number;
  warning: number;
  maxReported: number;
  ignoredZones: ReadonlySet<string>;
  excludeSelectors: readonly string[];
  excludeShopLinks: boolean;
  shopBasePath: string;
  companyTokens: string[];
}

export class AnchorTextAnalyzer extends BaseAnalyzer {
  readonly id = 'ANCHOR_TEXT';
  readonly title = 'Concordance ancres & URLs';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const config = settings.anchorText;
    if (config?.enabled === false) {
      return Promise.resolve(this.na('Analyse de concordance désactivée dans le profil.'));
    }

    const thresholds = this.readThresholds(page, config);
    const verdicts = this.examine(page, thresholds);

    if (verdicts.length === 0) {
      return Promise.resolve(
        this.pass(
          [
            {
              key: 'ANCHOR_TEXT.no_links',
              label: 'Aucun lien interne de contenu analysable',
              status: 'pass',
            },
          ],
          'Aucun lien interne de contenu à analyser sur cette page.',
        ),
      );
    }

    return Promise.resolve(this.report(verdicts, thresholds));
  }

  private readThresholds(page: HtmlPage, config: EffectiveSettings['anchorText']): Thresholds {
    const excludeShopLinks = config?.excludeShopLinks ?? false;
    let shopBasePath = config?.shopBasePath ?? '';

    // Le chemin de la boutique se lit dans la page quand le profil ne le fixe
    // pas : il diffère entre l'aperçu et le site publié, et le figer dans un
    // profil le rendrait faux sur l'un des deux.
    if (excludeShopLinks && !shopBasePath) {
      shopBasePath = detectShopPath(page) ?? '';
    }

    return {
      // Les seuils sont stockés en pourcentage entier dans les réglages.
      concordant: (config?.concordanceThreshold ?? 60) / 100,
      warning: (config?.warningThreshold ?? 35) / 100,
      maxReported: config?.maxLinksReported ?? 20,
      ignoredZones: new Set(config?.ignoreZones ?? ['nav', 'header', 'footer']),
      excludeSelectors: config?.excludeSelectors ?? [],
      excludeShopLinks,
      shopBasePath,
      companyTokens: companyNameTokens(config?.companyName ?? ''),
    };
  }

  private examine(page: HtmlPage, thresholds: Thresholds): LinkVerdict[] {
    const { $ } = page;
    const verdicts: LinkVerdict[] = [];
    const host = hostnameOf(page.url);

    $('a[href]').each((_, element) => {
      const node = $(element);
      if (isExcluded(node, thresholds.excludeSelectors)) return;
      if (thresholds.ignoredZones.has(zoneOf(node))) return;

      const href = node.attr('href') ?? '';
      if (!isAnalysableTarget(href, page.url, host)) return;

      const anchor = node.text().trim();
      // Un lien dont le seul contenu est une image relève du critère LOGO.
      if (!anchor || anchor.length > MAX_ANCHOR_LENGTH) return;

      const verdict = this.judge(anchor, href, page, thresholds, truncateSource($.html(element)));
      if (verdict) verdicts.push(verdict);
    });

    return verdicts;
  }

  private judge(
    anchor: string,
    href: string,
    page: HtmlPage,
    thresholds: Thresholds,
    source: string | undefined,
  ): LinkVerdict | null {
    const base = { anchor, href, source };

    if (isGenericAnchor(anchor)) {
      return {
        ...base,
        level: 'generic',
        score: 0,
        tokens: [],
        segments: [],
        precision: 0,
        recall: 0,
      };
    }

    const tokens = tokenize(anchor);
    const segments = hrefSegments(href, page.url);

    if (thresholds.excludeShopLinks && this.isShopTarget(href, page.url, segments, thresholds)) {
      return null;
    }

    const preclassified =
      this.classifyByIntent(anchor, tokens, segments, base) ??
      this.classifyByCompany(tokens, segments, thresholds, base);
    if (preclassified) return preclassified;

    // Ni l'ancre ni l'URL n'offrent de matière à comparer : « /page1 » ne dit
    // rien, et l'annoncer discordant accuserait à tort.
    if (tokens.length === 0 || segments.length === 0) {
      return {
        ...base,
        level: 'ambiguous',
        score: -1,
        tokens,
        segments,
        precision: 0,
        recall: 0,
      };
    }

    const { fBeta, precision, recall } = computeFBetaScore(tokens, segments);
    let score = Math.max(fBeta, categoryBonus(tokens, segments));
    if (score < thresholds.concordant) {
      score = promoteByDominantToken(score, tokens, segments, thresholds);
    }

    return {
      ...base,
      level:
        score >= thresholds.concordant
          ? 'concordant'
          : score >= thresholds.warning
            ? 'probable'
            : 'discordant',
      score,
      tokens,
      segments,
      precision,
      recall,
    };
  }

  private isShopTarget(
    href: string,
    pageUrl: string,
    segments: string[],
    thresholds: Thresholds,
  ): boolean {
    return thresholds.shopBasePath
      ? isShopLink(href, pageUrl, thresholds.shopBasePath)
      : segments.some(segment => SHOP_PATH_SEGMENTS.has(segment));
  }

  /**
   * Ancres à sémantique non textuelle — adresse, téléphone, courriel.
   *
   * Leur rappel est nul par construction : les mots « rue » ou « Lyon » ne se
   * retrouvent pas dans le segment « contact ». Sans ce court-circuit, une
   * adresse postale liée à la page de contact serait rapportée discordante.
   */
  private classifyByIntent(
    anchor: string,
    tokens: string[],
    segments: string[],
    base: { anchor: string; href: string; source: string | undefined },
  ): LinkVerdict | null {
    if (segments.length === 0 || !isContactOrLocationUrl(segments)) return null;
    if (!isAddressAnchor(anchor) && !isPhoneAnchor(anchor) && !isEmailAnchor(anchor)) return null;

    return {
      ...base,
      level: 'concordant',
      score: PRECLASSIFIED_SCORE,
      tokens,
      segments,
      precision: PRECLASSIFIED_SCORE,
      recall: PRECLASSIFIED_SCORE,
    };
  }

  /**
   * Ancre reprenant la raison sociale — lien de marque.
   *
   * Un nom propre n'apparaît pas dans l'URL : le calcul le noterait zéro. Un
   * match COMPLET vaut donc concordance vers n'importe quelle page éditoriale ;
   * un match PARTIEL ne vaut que vers une page « à propos », garde-fou contre
   * les jetons ambigus. Une destination commerciale n'en bénéficie jamais : une
   * ancre de marque vers une page produit doit décrire ce produit.
   */
  private classifyByCompany(
    tokens: string[],
    segments: string[],
    thresholds: Thresholds,
    base: { anchor: string; href: string; source: string | undefined },
  ): LinkVerdict | null {
    if (thresholds.companyTokens.length === 0) return null;

    const anchorStems = new Set(tokens.map(token => stem(token)));
    const companyStems = thresholds.companyTokens.map(token => stem(token));
    const matches = companyStems.filter(candidate => anchorStems.has(candidate)).length;

    const fullMatch = matches > 0 && matches === companyStems.length;
    // Un nom réduit à un mot court est trop générique pour valoir promotion.
    const distinctive =
      companyStems.length >= 2 || companyStems.some(candidate => candidate.length >= 5);
    const aboutUrl = segments.length > 0 && isAboutUrl(segments);
    const commercial = segments.some(segment => SHOP_PATH_SEGMENTS.has(segment));

    if (!((fullMatch && distinctive && !commercial) || (matches > 0 && aboutUrl))) return null;

    const score = fullMatch ? PRECLASSIFIED_SCORE : PARTIAL_COMPANY_SCORE;
    return {
      ...base,
      level: 'concordant',
      score,
      tokens,
      segments,
      precision: score,
      recall: score,
      note:
        fullMatch && !aboutUrl
          ? 'Ancre = raison sociale (lien de marque)'
          : 'Raison sociale vers une page « à propos »',
    };
  }

  private report(verdicts: LinkVerdict[], thresholds: Thresholds): CheckResult {
    const count = (level: Level): number =>
      verdicts.filter(verdict => verdict.level === level).length;

    const concordant = count('concordant');
    const probable = count('probable');
    const ambiguous = count('ambiguous');
    const discordant = count('discordant');
    const generic = count('generic');
    const analysed = verdicts.length - generic;

    const items: CheckItem[] = [
      {
        key: 'ANCHOR_TEXT.summary',
        label: `${analysed} lien(s) analysé(s) : ${concordant} concordant(s), ${probable} probable(s), ${discordant} discordant(s)`,
        status: summaryStatus(discordant, generic, analysed),
        detail: `Concordants : ${concordant} | Probables : ${probable} | Ambigus : ${ambiguous} | Discordants : ${discordant} | Génériques : ${generic}`,
      },
    ];
    const recommendations: string[] = [];

    const discordantLinks = verdicts
      .filter(verdict => verdict.level === 'discordant')
      .slice(0, thresholds.maxReported);
    for (const link of discordantLinks) {
      items.push({
        key: 'ANCHOR_TEXT.discordant',
        label: `« ${link.anchor} » → ${link.href}`,
        status: 'fail',
        value: link.href,
        detail: measurement(link),
        locator: locateFromText(link.anchor),
        source: link.source,
      });
    }

    // Les ambigus partagent le quota des discordants : c'est la liste des
    // défauts qui doit rester lisible, pas chaque catégorie prise à part.
    const ambiguousLinks = verdicts
      .filter(verdict => verdict.level === 'ambiguous')
      .slice(0, Math.max(0, thresholds.maxReported - discordantLinks.length));
    for (const link of ambiguousLinks) {
      items.push({
        key: 'ANCHOR_TEXT.ambiguous',
        label: `« ${link.anchor} » → ${link.href}`,
        status: 'warning',
        value: link.href,
        detail:
          link.score >= 0
            ? `${measurement(link)} — segments d'URL trop courts pour conclure`
            : 'Segments d’URL non analysables (chemin trop court ou numérique).',
        locator: locateFromText(link.anchor),
        source: link.source,
      });
    }

    // Les concordances sont montrées elles aussi : voir POURQUOI un lien passe
    // vaut mieux que de découvrir un jour qu'on ne sait plus pourquoi.
    for (const level of ['concordant', 'probable'] as const) {
      for (const link of verdicts
        .filter(verdict => verdict.level === level)
        .slice(0, thresholds.maxReported)) {
        items.push({
          key: `ANCHOR_TEXT.${level}`,
          label: `« ${link.anchor} » → ${link.href}`,
          status: 'info',
          value: link.href,
          detail: `${link.note ? `${link.note} · ` : ''}${measurement(link)}`,
        });
      }
    }

    if (generic > 0) {
      const samples = verdicts
        .filter(verdict => verdict.level === 'generic')
        .slice(0, 5)
        .map(verdict => `« ${verdict.anchor} »`)
        .join(', ');

      items.push({
        key: 'ANCHOR_TEXT.generic',
        label: `${generic} ancre(s) générique(s), sans valeur sémantique`,
        status: 'warning',
        detail: `Exemples : ${samples}`,
      });
      recommendations.push(
        `${generic} lien(s) portent une ancre générique. La remplacer par un texte qui nomme la page visée : c'est tout ce qu'un lecteur d'écran annonce.`,
      );
    }

    if (discordant > 0) {
      recommendations.push(
        `${discordant} lien(s) ont une ancre peu concordante avec leur destination (score sous ${Math.round(thresholds.warning * 100)} %).`,
      );
    }

    if (ambiguous > 0) {
      recommendations.push(
        `${ambiguous} lien(s) visent une URL sans segment textuel (« /page1 », « /123 ») : préférer des adresses parlantes.`,
      );
    }

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;
    const concordantRate =
      analysed > 0 ? Math.round(((concordant + probable) / analysed) * 100) : 100;

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore:
        failures >= 5 ? 1 : failures >= 3 ? 2 : failures >= 1 ? 3 : warnings >= 3 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${verdicts.length} lien(s) de contenu examiné(s) — ${concordant + probable}/${analysed} ancres concordantes (${concordantRate} %), ${generic} générique(s).`,
      recommendations,
    };
  }
}

/**
 * Promotion par token dominant.
 *
 * Quand le mot porteur de l'ancre correspond fortement à l'URL, les
 * qualificatifs absents de celle-ci ne doivent pas masquer la concordance. Le
 * garde-fou : chaque segment d'URL doit être couvert, sans quoi « devis
 * plomberie » vers `/devis-peinture` serait promu à tort.
 */
function promoteByDominantToken(
  score: number,
  tokens: string[],
  segments: string[],
  thresholds: Thresholds,
): number {
  const expanded = tokens.flatMap(token => expandedTokens(token));
  const dominant = Math.max(0, ...tokens.map(token => bestTokenScore(token, segments)));
  const covered = segments.every(segment =>
    expanded.some(token => tokenVsSegment(token, segment) >= SEGMENT_COVERED),
  );

  if (!covered) return score;
  if (dominant >= DOMINANT_CONCORDANT) return Math.max(score, thresholds.concordant);
  if (dominant >= DOMINANT_PROBABLE) return Math.max(score, thresholds.warning);
  return score;
}

/** Le critère échoue quand une part notable des liens est discordante. */
function summaryStatus(discordant: number, generic: number, analysed: number): CheckStatus {
  if (discordant === 0 && generic === 0) return 'pass';
  return discordant / Math.max(analysed, 1) > FAILURE_RATIO ? 'fail' : 'warning';
}

function measurement(link: LinkVerdict): string {
  return (
    `Score ${Math.round(link.score * 100)} % ` +
    `(précision ${Math.round(link.precision * 100)} % / rappel ${Math.round(link.recall * 100)} %) ` +
    `| mots : [${link.tokens.join(', ')}] | segments : [${link.segments.join(', ')}]`
  );
}

/**
 * Une ancre est générique si elle figure au répertoire, ou si tous ses mots
 * significatifs sont des mots-outils.
 *
 * La liste des mots significatifs doit être NON VIDE : `every` sur une liste
 * vide vaut vrai, si bien qu'en v1 une ancre faite uniquement de mots courts
 * — « 04 72 00 00 00 », par exemple — était déclarée générique. Un numéro de
 * téléphone n'est pas une ancre générique : c'est au contraire l'information
 * la plus précise qu'un lien puisse porter.
 */
function isGenericAnchor(anchor: string): boolean {
  const normalized = normalize(anchor);
  if (GENERIC_ANCHORS.has(normalized)) return true;

  const significant = normalized.split(' ').filter(word => word.length >= MIN_SIGNIFICANT_WORD);

  return significant.length > 0 && significant.every(word => STOPWORDS.has(word));
}

function zoneOf(node: Selection): string {
  if (
    node.closest('nav, [role="navigation"], .nav, .menu, .dmNav, [data-element-type="menu"]').length
  ) {
    return 'nav';
  }
  if (
    node.closest('header, [role="banner"], .header, .dmHeaderContainer, .flex_hfcontainer').length
  ) {
    return 'header';
  }
  if (node.closest('footer, [role="contentinfo"], .footer, .dmFooterContainer').length) {
    return 'footer';
  }
  return 'content';
}

/** Sélecteurs d'exclusion du profil — un sélecteur invalide n'exclut rien. */
function isExcluded(node: Selection, selectors: readonly string[]): boolean {
  return selectors.some(selector => {
    try {
      return node.is(selector) || node.closest(selector).length > 0;
    } catch {
      return false;
    }
  });
}

/**
 * La cible mérite-t-elle d'être comparée ?
 *
 * Sont écartés : les protocoles qui ne mènent pas à une page, les domaines
 * extérieurs — dont nous ne maîtrisons pas les URL — et les ancres intra-page,
 * qui ne changent pas de document.
 */
function isAnalysableTarget(href: string, pageUrl: string, host: string): boolean {
  if (
    !href ||
    href === '#' ||
    href.startsWith('tel:') ||
    href.startsWith('mailto:') ||
    href.startsWith('javascript:')
  ) {
    return false;
  }

  try {
    const target = new URL(href, pageUrl);
    if (target.hostname && target.hostname !== host) return false;
    return !(target.pathname === new URL(pageUrl).pathname && target.hash);
  } catch {
    return false;
  }
}

function detectShopPath(page: HtmlPage): string | null {
  const { $ } = page;

  for (const element of $('script:not([src])').toArray()) {
    const match = /StorePath\s*:\s*['"]([^'"]+)['"]/.exec($(element).html() ?? '');
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
