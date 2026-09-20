import type { DomElement, Selection } from './page.model.js';

/**
 * Parcours d'ancêtres — le socle des lectures de contexte.
 *
 * Situer un lien dans une page revient toujours à remonter ses ancêtres en
 * cherchant un signal. Cheerio sait le faire (`parents`, `closest`, `is`), mais
 * chacun de ces appels reparse et recompile son sélecteur : sur une page de
 * plusieurs centaines de liens, c'est le poste le plus coûteux du moteur. Les
 * critères remontent donc eux-mêmes, sur des attributs déjà lus.
 */

/** Élément du document, quand le nœud en est un. */
export function elementOf(node: unknown): DomElement | null {
  return node && typeof node === 'object' && 'attribs' in node ? (node as DomElement) : null;
}

/** Premier élément d'une sélection Cheerio. */
export function firstElementOf(selection: Selection): DomElement | null {
  return elementOf(selection.get(0));
}

/** Ancêtres d'un élément, du plus proche au plus lointain. */
export function* ancestorsOf(element: DomElement): Generator<DomElement> {
  let current = elementOf(element.parent);
  while (current) {
    yield current;
    current = elementOf(current.parent);
  }
}

/** L'élément lui-même, puis ses ancêtres. */
export function* selfAndAncestors(element: DomElement): Generator<DomElement> {
  yield element;
  yield* ancestorsOf(element);
}

/**
 * Un ancêtre — ou l'élément lui-même — porte-t-il le signal cherché ?
 *
 * Le résultat est mémorisé par élément : sur une page de deux cents liens, la
 * même chaîne d'ascendance serait remontée deux cents fois sans cela.
 */
export function hasAncestorMatching(
  node: Selection,
  cache: WeakMap<object, boolean>,
  matches: (element: DomElement) => boolean,
  options: { includeSelf: boolean },
): boolean {
  const element = firstElementOf(node);
  if (!element) return false;

  const known = cache.get(element);
  if (known !== undefined) return known;

  const chain = options.includeSelf ? selfAndAncestors(element) : ancestorsOf(element);
  let found = false;
  for (const current of chain) {
    if (matches(current)) {
      found = true;
      break;
    }
  }

  cache.set(element, found);
  return found;
}

/** Jetons de la classe d'un élément — `class="a b"` donne `['a', 'b']`. */
export function classTokensOf(element: DomElement): string[] {
  return (element.attribs?.['class'] ?? '').split(/\s+/);
}

/** `[class*="x"]` — sous-chaîne de l'attribut, comme le sélecteur d'origine. */
export function classIncludesAny(element: DomElement, parts: readonly string[]): boolean {
  const classes = element.attribs?.['class'] ?? '';
  return parts.some(part => classes.includes(part));
}

/**
 * Première image sous un élément, en profondeur d'abord.
 *
 * `find('img')` construit une sélection Cheerio et compile son sélecteur à
 * chaque appel, pour une question à laquelle un parcours répond directement —
 * et qui s'arrête à la PREMIÈRE trouvée, là où `find` les collecte toutes.
 */
export function firstImageIn(element: DomElement | null): DomElement | null {
  if (!element) return null;

  for (const child of childElementsOf(element)) {
    if (child.name === 'img') return child;
    const nested = firstImageIn(child);
    if (nested) return nested;
  }
  return null;
}

/** Enfants ÉLÉMENTS d'un nœud — les nœuds de texte n'en sont pas. */
function* childElementsOf(element: DomElement): Generator<DomElement> {
  const children: unknown = (element as { children?: unknown }).children;
  if (!Array.isArray(children)) return;

  for (const child of children) {
    const asElement = elementOf(child);
    if (asElement) yield asElement;
  }
}
