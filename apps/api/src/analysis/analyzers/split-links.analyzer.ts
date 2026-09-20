import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { locateFromText } from '../locate.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Liens collés au texte, et liens consécutifs en doublon.
 *
 * Deux défauts invisibles à la relecture d'un auteur mais bien visibles au
 * rendu : « grande » suivi d'un lien « hauteur » s'affiche « grandehauteur », et
 * trois liens adjacents vers la même page lisent trois fois la même
 * destination au lecteur d'écran.
 *
 * Le critère ne regarde QUE les blocs de contenu éditorial : dans un menu ou un
 * pied de page, des liens adjacents vers la même cible sont normaux.
 */

const CONTENT_BLOCKS = '.dmNewParagraph, .wpb_text_column';
/**
 * Les `<a>` DANS ces blocs.
 *
 * Écrire `${CONTENT_BLOCKS} a` ne marcherait pas : en CSS, `A, B C` sélectionne
 * `A` ET les `C` sous `B` — le premier bloc lui-même serait retourné.
 */
const CONTENT_LINKS = '.dmNewParagraph a, .wpb_text_column a';
const CONTENT_LINKS_WITH_HREF = '.dmNewParagraph a[href], .wpb_text_column a[href]';

/** Plafond d'items localisables par catégorie — un rapport reste lisible. */
const MAX_LOCATED = 20;
/** Garde-fou du parcours d'arbre : au-delà, les liens ne sont pas adjacents. */
const MAX_TREE_STEPS = 100;

/** Abréviations après lesquelles l'absence d'espace est normale. */
const UNIT_PREFIXES: ReadonlySet<string> = new Set([
  'm',
  'km',
  'cm',
  'mm',
  'kg',
  'g',
  'l',
  'ml',
  'h',
  'min',
  'sec',
  'no',
  'n°',
]);

/** Caractères finaux qui rendent l'absence d'espace légitime. */
const PUNCTUATION_BEFORE: ReadonlySet<string> = new Set([
  '"',
  "'",
  '(',
  '[',
  '{',
  '«',
  '.',
  ':',
  ';',
  ',',
  '/',
  '\\',
]);

/**
 * Vue minimale d'un nœud domhandler.
 *
 * Cheerio n'exporte pas le type de ses nœuds ; l'interface décrit donc ce
 * dont le parcours d'arbre a besoin, et les éléments cheerio la satisfont
 * STRUCTURELLEMENT — aucune conversion n'est nécessaire.
 */
interface DomNode {
  type: string;
  data?: string;
  children?: DomNode[];
  parent?: DomNode | null;
  next?: DomNode | null;
  prev?: DomNode | null;
}

interface SplitLink {
  text: string;
  contextBefore: string;
}

interface DuplicateGroup {
  href: string;
  count: number;
  texts: string[];
}

export class SplitLinksAnalyzer extends BaseAnalyzer {
  readonly id = 'SPLIT_LINKS';
  readonly title = 'Liens coupés & doublons consécutifs';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    if (page.$(CONTENT_BLOCKS).length === 0) {
      return Promise.resolve(
        this.na('Aucun bloc de contenu éditorial détecté — critère non applicable.'),
      );
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const split = this.detectSplitLinks(page);
    const duplicates = this.detectConsecutiveDuplicates(page);

    this.reportSplit(split, items, recommendations);
    this.reportDuplicates(duplicates, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures >= 2 ? 0 : failures === 1 ? 2 : 5,
      status: failures > 0 ? 'fail' : 'pass',
      items,
      summary: `${split.length} lien(s) coupé(s), ${duplicates.length} groupe(s) en doublon consécutif.`,
      recommendations,
    });
  }

  private reportSplit(split: SplitLink[], items: CheckItem[], recommendations: string[]): void {
    const first = split[0];
    if (!first) {
      items.push({ key: 'SPLIT.no_split', label: 'Aucun lien coupé détecté', status: 'pass' });
      return;
    }

    items.push({
      key: 'SPLIT.split_found',
      label: `${split.length} lien(s) coupé(s) détecté(s)`,
      status: 'fail',
      detail: split
        .map(problem => `« …${problem.contextBefore} » + lien « ${problem.text} »`)
        .join('\n'),
      locator: locateFromText(first.text),
    });

    // Un item par occurrence, en `info` : il porte son propre ancrage vers
    // l'élément fautif sans peser une seconde fois sur la note, que l'item de
    // synthèse ci-dessus porte déjà.
    for (const problem of split.slice(0, MAX_LOCATED)) {
      items.push({
        key: 'SPLIT.split_item',
        label: `Lien collé au texte : « ${problem.text} »`,
        status: 'info',
        value: problem.text,
        detail: `Contexte : « …${problem.contextBefore} » + « ${problem.text} »`,
        locator: locateFromText(problem.text),
      });
    }

    recommendations.push(
      `Ajouter un espace avant ${split.length} lien(s) collé(s) au texte précédent, qui s'affichent aujourd'hui en un seul mot.`,
    );
  }

  private reportDuplicates(
    duplicates: DuplicateGroup[],
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const first = duplicates[0];
    if (!first) {
      items.push({
        key: 'SPLIT.no_duplicate',
        label: 'Aucun doublon de lien consécutif détecté',
        status: 'pass',
      });
      return;
    }

    items.push({
      key: 'SPLIT.duplicate_found',
      label: `${duplicates.length} groupe(s) de liens consécutifs en doublon`,
      status: 'fail',
      detail: duplicates
        .map(group => `${group.count}× « ${group.texts.join(' » + « ')} » → ${group.href}`)
        .join('\n'),
      locator: locateFromText(first.texts[0]),
    });

    for (const group of duplicates.slice(0, MAX_LOCATED)) {
      items.push({
        key: 'SPLIT.duplicate_item',
        label: `${group.count}× lien vers ${group.href}`,
        status: 'info',
        value: group.href,
        detail: `Textes : « ${group.texts.join(' » + « ')} »`,
        locator: locateFromText(group.texts[0]),
      });
    }

    recommendations.push(
      `Fusionner ${duplicates.length} groupe(s) de liens consécutifs pointant vers la même URL.`,
    );
  }

  private detectSplitLinks(page: HtmlPage): SplitLink[] {
    const { $ } = page;
    const problems: SplitLink[] = [];

    $(CONTENT_LINKS).each((_, element) => {
      const node = $(element);
      const text = node.text().trim();
      // Un lien purement visuel n'a pas de texte à coller au précédent.
      if (!text) return;

      const before = previousText(element);
      if (!before) return;

      const lastChar = before.slice(-1);
      const firstChar = text.charAt(0);
      const glued = !/\s$/.test(before);
      const alphanumeric = /[a-zA-ZÀ-ÿ0-9]/;

      if (
        !glued ||
        !alphanumeric.test(lastChar) ||
        !alphanumeric.test(firstChar) ||
        PUNCTUATION_BEFORE.has(lastChar)
      ) {
        return;
      }

      // « 30m » suivi d'un lien n'est pas un lien coupé mais une unité.
      const lastWord = before.trimEnd().split(/\s+/).pop() ?? '';
      if (UNIT_PREFIXES.has(lastWord.toLowerCase())) return;

      problems.push({ text, contextBefore: before.slice(-25).trim() });
    });

    return problems;
  }

  private detectConsecutiveDuplicates(page: HtmlPage): DuplicateGroup[] {
    const { $ } = page;
    const links = $(CONTENT_LINKS_WITH_HREF).toArray();
    const groups: DuplicateGroup[] = [];

    let index = 0;
    while (index < links.length) {
      const current = links[index];
      const href = current ? normalizeHref($(current).attr('href') ?? '') : '';
      if (!current || !href) {
        index += 1;
        continue;
      }

      const group = [current];
      let next = index + 1;
      while (next < links.length) {
        const candidate = links[next];
        if (!candidate) break;
        if (normalizeHref($(candidate).attr('href') ?? '') !== href) break;

        const last = group[group.length - 1];
        if (!last) break;
        if (!areConsecutive(last, candidate)) break;

        group.push(candidate);
        next += 1;
      }

      if (group.length > 1) {
        groups.push({
          href,
          count: group.length,
          texts: group.map(element => $(element).text().trim().slice(0, 40)),
        });
        index = next;
        continue;
      }

      index += 1;
    }

    return groups;
  }
}

/**
 * Texte du nœud qui précède immédiatement un élément.
 *
 * On lit le frère précédent BRUT, nœuds de texte compris : c'est justement
 * l'espace — présent ou absent — qui décide, et une lecture qui le normaliserait
 * effacerait la seule information recherchée.
 */
function previousText(element: DomNode): string {
  const previous = element.prev;
  if (!previous) return '';
  return previous.type === 'text' ? (previous.data ?? '') : nodeText(previous);
}

function nodeText(node: DomNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map(child => nodeText(child)).join('');
}

/**
 * Deux liens sont-ils adjacents au rendu ?
 *
 * On parcourt l'arbre entre eux : tout texte non vide rencontré les sépare. Le
 * parcours traverse les balises intermédiaires (`<span>`, `<em>`), sans quoi
 * deux liens frères dans des `<span>` distincts passeraient pour éloignés alors
 * qu'ils se touchent à l'écran.
 */
function areConsecutive(first: DomNode, second: DomNode): boolean {
  const ancestor = commonAncestor(first, second);
  if (!ancestor) return false;

  let current = nextInTree(first, ancestor);
  let steps = 0;

  while (current && current !== second && steps < MAX_TREE_STEPS) {
    steps += 1;

    if (current.type === 'tag') {
      if (contains(current, second)) {
        current = current.children?.[0] ?? nextInTree(current, ancestor);
        continue;
      }
      if (nodeText(current).trim() !== '') return false;
    } else if (current.type === 'text' && (current.data ?? '').trim() !== '') {
      return false;
    }

    current = nextInTree(current, ancestor);
  }

  return current === second;
}

function commonAncestor(first: DomNode, second: DomNode): DomNode | null {
  const ancestors = new Set<DomNode>();
  for (let node: DomNode | null | undefined = first; node; node = node.parent) ancestors.add(node);
  for (let node: DomNode | null | undefined = second; node; node = node.parent) {
    if (ancestors.has(node)) return node;
  }
  return null;
}

function nextInTree(node: DomNode, root: DomNode): DomNode | null {
  if (node.next) return node.next;
  for (let current = node.parent; current && current !== root; current = current.parent) {
    if (current.next) return current.next;
  }
  return null;
}

function contains(ancestor: DomNode, node: DomNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/** Deux URL ne diffèrent pas parce qu'elles portent un `?utm_source` ou un `#`. */
function normalizeHref(href: string): string {
  try {
    const parsed = new URL(href);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return href.trim().replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
}
