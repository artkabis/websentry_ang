import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import { auditPageContrast, type AuditElementResult } from '../css/contrast-resolver.js';
import type { CssFetchImpl } from '../css/micro-cssom.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText } from '../locate.js';
import type { NetworkProbe } from '../network-probe.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Contraste des textes — WCAG 2.2, critère 1.4.3.
 *
 * Le contraste ne se lit pas dans le HTML : il faut résoudre la cascade CSS,
 * l'héritage, les variables et la composition alpha des fonds. C'est ce que
 * fait le micro-moteur de `css/` — sans navigateur, et donc sans rendre la
 * page.
 *
 * Les résultats sont GROUPÉS par paire de couleurs : une page moderne répète la
 * même faute cent fois, et cent lignes identiques dans un rapport reviennent à
 * n'en avoir aucune.
 */

/**
 * Plafond de lecture d'une feuille externe.
 *
 * Une charte tient largement dans ce volume ; au-delà, on a affaire à une
 * feuille d'utilitaires concaténée, dont la fin ne change rien au contraste des
 * textes de la page.
 */
const MAX_CSS_BYTES = 512 * 1024;

/** Nombre d'extraits de texte cités par groupe de couleurs. */
const MAX_EXCERPTS = 3;
/** Longueur d'un extrait dans le détail. */
const MAX_EXCERPT_LENGTH = 40;

interface ColorGroup {
  first: AuditElementResult;
  foreground: string;
  background: string;
  count: number;
  excerpts: string[];
  /** Ratio le plus BAS du groupe — le pire cas est ce qui doit être corrigé. */
  worstRatio: number;
}

export class ContrastAnalyzer extends BaseAnalyzer {
  readonly id = 'CONTRAST_V2';
  readonly title = 'Contraste des couleurs (WCAG)';

  async analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return this.na();

    // Le document DÉJÀ analysé est passé au moteur : le reparser coûterait un
    // second `cheerio.load` complet, le poste le plus cher de ce critère.
    //
    // Les feuilles externes passent par la SONDE, seule porte de sortie : la
    // politique SSRF s'y applique, le volume lu est borné, et le budget de
    // requêtes du critère est décompté comme pour tout le reste. Sans sonde, le
    // moteur reste sur les styles embarqués et en ligne — et le rapport le dit.
    const { elements, truncated, externalSheets } = await auditPageContrast(page.$, {
      baseUrl: page.url,
      fetchCss: net ? cssFetcherOf(net) : undefined,
    });

    if (elements.length === 0) {
      return this.na('Aucun élément textuel analysable sur cette page.');
    }

    const { passing, failing, review } = groupByColors(elements);
    const items: CheckItem[] = [];

    // Les échecs d'abord : c'est ce qui demande une action.
    for (const group of failing.values()) items.push(failureItem(group));
    for (const element of review) items.push(reviewItem(element));
    for (const group of passing.values()) items.push(successItem(group));

    const failingCount = countOf(failing);
    const passingCount = countOf(passing);
    const scored = failingCount + passingCount;

    const unread = externalSheets.declared - externalSheets.loaded;
    if (unread > 0) {
      // Sans clé, donc hors décompte : ce n'est pas un défaut de la page, c'est
      // une part de la charte que la mesure n'a pas vue. La taire laisserait
      // conclure sur des valeurs par défaut sans le dire.
      items.push({
        label: `${unread} feuille(s) de style externe(s) non mesurée(s)`,
        status: 'info',
        detail: net
          ? 'Feuille injoignable, refusée par la politique de sécurité, ou au-delà du plafond de lecture.'
          : 'Aucune sortie réseau disponible : seuls les styles embarqués et en ligne ont été mesurés.',
      });
    }

    if (truncated) {
      // Sans clé, donc hors décompte : une limite de l'analyse n'est pas un
      // point de contrôle. La taire laisserait conclure « conforme » sur ce
      // qui n'a pas été regardé.
      items.push({
        label: 'Page trop longue : seuls les premiers textes ont été mesurés',
        status: 'info',
      });
    }

    if (scored === 0) {
      // Aucun texte mesurable : tous sont posés sur une image ou un empilement
      // de couches. Rendre 5 sur 5 décernerait une note à une page dont rien
      // n'a été mesuré — c'est une absence de verdict, pas un verdict. Les
      // textes à vérifier à l'œil restent montrés : c'est tout ce que
      // l'analyse a produit.
      return this.na(
        `Contraste non mesurable : ${review.length} texte(s) sur fond non uniforme, aucun texte sur fond calculable.`,
        items,
      );
    }

    // La note est la PROPORTION de textes conformes : un défaut isolé sur cent
    // textes ne vaut pas le même reproche qu'une page entière illisible.
    const globalScore = Math.round((passingCount / scored) * 50) / 10;
    const summary =
      `${passingCount} texte(s) conforme(s), ${failingCount} insuffisant(s)` +
      (review.length > 0 ? `, ${review.length} à vérifier à l'œil` : '');

    return failingCount > 0
      ? this.fail(
          items,
          summary,
          [
            'Renforcer le contraste des textes signalés — WCAG 2.2 AA : au moins 4,5:1 pour un texte courant, 3:1 pour un grand texte.',
          ],
          globalScore,
        )
      : this.pass(items, summary, globalScore);
  }
}

interface Grouped {
  passing: Map<string, ColorGroup>;
  failing: Map<string, ColorGroup>;
  review: AuditElementResult[];
}

/**
 * Regroupe par couleur d'avant-plan, couleur de fond et taille.
 *
 * La taille entre dans la clé parce que le seuil en dépend : le même couple de
 * couleurs peut être conforme en grand titre et fautif en texte courant.
 */
function groupByColors(evaluations: readonly AuditElementResult[]): Grouped {
  const grouped: Grouped = { passing: new Map(), failing: new Map(), review: [] };

  for (const element of evaluations) {
    // Fond non uniforme (image, dégradé) : le contraste n'est pas calculable,
    // et le déclarer fautif accuserait au hasard.
    if (element.needsManualReview) {
      grouped.review.push(element);
      continue;
    }

    const foreground = toHex(element.fg);
    const background = toHex(element.bg);
    const key = `${foreground}|${background}|${element.isLarge ? 'L' : 'N'}`;
    const target = element.AA ? grouped.passing : grouped.failing;

    const existing = target.get(key);
    if (!existing) {
      target.set(key, {
        first: element,
        foreground,
        background,
        count: 1,
        excerpts: [excerptOf(element)],
        worstRatio: element.ratio,
      });
      continue;
    }

    existing.count += 1;
    if (element.ratio < existing.worstRatio) existing.worstRatio = element.ratio;
    if (existing.excerpts.length < MAX_EXCERPTS) existing.excerpts.push(excerptOf(element));
  }

  return grouped;
}

/**
 * Libellé STABLE, sans le nombre d'occurrences.
 *
 * Le même défaut doit porter le même intitulé d'une page à l'autre, sans quoi
 * une vue multi-pages le compterait comme plusieurs défauts distincts. Le
 * décompte va dans le détail.
 */
function failureItem(group: ColorGroup): CheckItem {
  return {
    key: 'CONTRAST_V2.low',
    label: `Contraste insuffisant (${group.worstRatio}:1${group.first.isLarge ? ', grand texte' : ''}) : ${group.foreground} sur ${group.background}`,
    status: 'fail',
    detail: detailOf(group),
    locator: locateFromText(group.first.text),
  };
}

function successItem(group: ColorGroup): CheckItem {
  return {
    key: 'CONTRAST_V2.ok',
    label: `Contraste conforme ${group.first.AAA ? 'AAA' : 'AA'} (${group.worstRatio}:1${group.first.isLarge ? ', grand texte' : ''}) : ${group.foreground} sur ${group.background}`,
    status: 'pass',
    detail: detailOf(group),
  };
}

function reviewItem(element: AuditElementResult): CheckItem {
  return {
    key: 'CONTRAST_V2.review',
    label: `À vérifier à l'œil : <${element.tag}> « ${element.text} »${locationOf(element)}`,
    // `info` : ni un défaut constaté — un fond en image n'en est pas un — ni un
    // succès. Le donner pour conforme le ferait disparaître du filtre « à
    // traiter », alors que c'est précisément ce qui réclame un œil humain.
    status: 'info',
    detail: 'Fond non uniforme (image, dégradé ou surimpression) — contraste non calculable.',
    locator: locateFromText(element.text),
  };
}

function detailOf(group: ColorGroup): string {
  const prefix = group.count > 1 ? `${group.count} occurrences — ` : '';
  const remaining = group.count > MAX_EXCERPTS ? ` (+${group.count - MAX_EXCERPTS} autre(s))` : '';
  return `${prefix}${group.excerpts.join(' · ')}${remaining}`;
}

function excerptOf(element: AuditElementResult): string {
  return `« ${element.text.slice(0, MAX_EXCERPT_LENGTH)} »${locationOf(element)}`;
}

/** Repère DOM de l'élément — utile quand deux textes identiques se ressemblent. */
function locationOf(element: AuditElementResult): string {
  const parts = [element.id ? `#${element.id}` : '', element.classes ?? ''].filter(Boolean);
  return parts.length > 0 ? ` [${parts.join('')}]` : '';
}

/**
 * Lecture d'une feuille, branchée sur la sonde.
 *
 * Le moteur CSS ne connaît ni la sonde ni la politique SSRF : il reçoit une
 * fonction qui rend un texte, et rien d'autre. C'est ce qui lui garde sa
 * testabilité sans réseau.
 */
function cssFetcherOf(net: NetworkProbe): CssFetchImpl {
  return async (url: string) => {
    const { result, body } = await net.fetchText(url, MAX_CSS_BYTES);
    const text = result.ok && body !== null ? body : '';
    return { ok: text.length > 0, text: () => Promise.resolve(text) };
  };
}

function toHex(color: { r: number; g: number; b: number }): string {
  const channel = (value: number): string => Math.round(value).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function countOf(groups: ReadonlyMap<string, ColorGroup>): number {
  let total = 0;
  for (const group of groups.values()) total += group.count;
  return total;
}
