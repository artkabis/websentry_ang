/**
 * contrast-resolver.ts — Résolution du fond effectif + contraste WCAG 2.1.
 *
 * Utilise micro-cssom (zéro dépendance ajoutée) pour le calcul de style
 * calculé avec héritage, cascade, et custom properties résolues.
 */

import type { CheerioAPI } from 'cheerio';
import { buildCSSOM, fetchExternalCss } from './micro-cssom.js';
import type { CssFetchImpl } from './micro-cssom.js';
import type { CSSOMInstance } from './micro-cssom.js';
import {
  parseColor as parseColorImpl,
  blendOver as blendOverImpl,
  contrastRatio as contrastRatioImpl,
  isTransparent as isTransparentImpl,
  type Rgba,
} from './color.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de filtrage des faux positifs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Propage `hasBgImage = true` aux descendants quand un ancêtre porte un
 * `background-image`. Un CSS `::before` overlay ou une image de fond sur un
 * parent modifie le fond effectif mais n'est pas accessible en analyse statique.
 * Mettre à `false` pour ne rapporter que le `background-image` de l'élément lui-même.
 */
export const FP_PROPAGATE_ANCESTOR_BG_IMAGE = true;

/**
 * Quand fg === bg (ratio 1:1), marque l'élément `needsManualReview` plutôt que
 * de le compter comme échec. Ce cas survient typiquement quand un pseudo-élément
 * `::before`/`::after` (overlay sombre/clair) masque le fond solide sous-jacent —
 * le fond réel est correct mais notre résolution statique ne voit pas l'overlay.
 * Mettre à `false` pour signaler ces éléments comme échecs normaux.
 */
export const FP_SILENCE_RATIO_ONE = true;

/**
 * Ignore les éléments sans nœud texte direct (tout le contenu textuel provient
 * d'enfants avec leurs propres règles de couleur). Ces « conteneurs indirects »
 * héritent souvent d'une couleur par défaut qui ne s'applique à aucun glyphe
 * visible, produisant des faux échecs de contraste.
 * Mettre à `false` pour auditer tous les éléments du sélecteur sans exception.
 */
export const FP_SKIP_INDIRECT_TEXT_CONTAINERS = true;

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

/** Couleur sRGB — alias du type unifié de `color.ts`. */
export type RgbaColor = Rgba;

export interface ContrastElementResult {
  ratio: number;
  fg: RgbaColor;
  bg: RgbaColor;
  isLarge: boolean;
  hasBgImage: boolean;
  /** Fond image/dégradé détecté — vérification manuelle recommandée. */
  needsManualReview: boolean;
  /** Conforme WCAG AA (texte normal ≥ 4,5 ; grand texte ≥ 3). */
  AA: boolean;
  /** Conforme WCAG AAA (texte normal ≥ 7 ; grand texte ≥ 4,5). */
  AAA: boolean;
}

export interface AuditElementResult extends ContrastElementResult {
  tag: string;
  /** Extrait de texte (60 premiers caractères). */
  text: string;
  /** Attribut `id` de l'élément (si présent). */
  id?: string;
  /** Premières classes CSS de l'élément (ex. `.hero .title`). */
  classes?: string;
}

export interface AuditPageOptions {
  baseUrl?: string;
  /**
   * Lecture des feuilles externes.
   *
   * La PRÉSENCE de la fonction vaut autorisation : un drapeau séparé pourrait
   * dire « oui » sans que personne ne sache sortir, ou l'inverse. Sans elle, le
   * moteur reste sur les styles embarqués et en ligne.
   */
  fetchCss?: CssFetchImpl;
  /** Sélecteur CSS des éléments à auditer. */
  selector?: string;
  /**
   * Nombre maximal d'éléments audités. Défaut : 400.
   * Guard performance sur les pages très longues (e-commerce, doc…).
   */
  maxElements?: number;
}

/** Ce que l'audit d'une page rend : ses éléments, et s'il s'est arrêté avant la fin. */
export interface AuditPageResult {
  elements: AuditElementResult[];
  /** Feuilles externes déclarées par la page, et nombre réellement lu. */
  externalSheets: { declared: number; loaded: number };
  /**
   * Vrai quand le plafond d'éléments a été atteint.
   *
   * Sans cette information, un rapport tairait qu'il n'a vu qu'une partie de la
   * page — et conclurait « conforme » sur ce qu'il n'a pas regardé.
   */
  truncated: boolean;
}

export interface ResolveBackgroundOptions {
  /** Couleur de fond par défaut si aucun ancêtre n'en définit. Défaut : blanc opaque. */
  defaultBg?: RgbaColor;
  /** Applique l'opacité CSS lors de la composition alpha. Défaut : true. */
  useOpacity?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing couleurs — délégué au module unifié `color.ts`
// (couvre nommées, hex, rgb/hsl/hwb, lab/lch, oklab/oklch, color(), color-mix()).
// ─────────────────────────────────────────────────────────────────────────────

/** Parse une couleur CSS en sRGB. Re-export de `color.ts` (source unique). */
export const parseColor = parseColorImpl;

/** Composite alpha "source-over". Re-export de `color.ts`. */
export const blendOver = blendOverImpl;

const isTransparent = isTransparentImpl;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers gradient CSS
// ─────────────────────────────────────────────────────────────────────────────

/** Découpe une chaîne CSS en arguments par virgule de niveau 0 (respecte les parens imbriquées). */
function splitCssCommaArgs(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') depth--;
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

/**
 * Extrait les couleurs des stops d'un gradient CSS simple (linear/radial/conic).
 * Retourne null si le gradient contient url() ou si les stops ne sont pas parsables.
 * Ne supporte que les gradients à couche unique.
 */
function parseGradientStops(gradientStr: string): RgbaColor[] | null {
  if (gradientStr.includes('url(')) return null;
  if (!/(linear|radial|conic)-gradient/i.test(gradientStr)) return null;
  // Reject multi-layer backgrounds (top-level comma separates layers)
  if (splitCssCommaArgs(gradientStr).length > 1) return null;

  const nameEnd = gradientStr.indexOf('(');
  if (nameEnd === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = nameEnd; i < gradientStr.length; i++) {
    if (gradientStr[i] === '(') depth++;
    else if (gradientStr[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const inner = gradientStr.slice(nameEnd + 1, end);
  const parts = splitCssCommaArgs(inner);
  const colors: RgbaColor[] = [];

  for (const part of parts) {
    const t = part.trim();
    // Skip direction/position tokens: "to top", "45deg", "at center", digits, keywords
    if (/^(to[\s,]|at[\s,]|\d|circle|ellipse|closest|farthest|from)/i.test(t)) continue;
    // A stop may be "color percentage" — take only the color token
    const colorToken = t.split(/\s+/)[0] ?? '';
    if (!colorToken) continue;
    const parsed = parseColorImpl(colorToken);
    if (parsed) colors.push(parsed);
  }

  return colors.length >= 1 ? colors : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers faux positifs
// ─────────────────────────────────────────────────────────────────────────────

interface AncestorBgInfo {
  /** Ancestor has a url()-based background-image that can't be analyzed. */
  hasBgUrl: boolean;
  /** Nearest ancestor has a pure CSS gradient with parseable stops. */
  gradientStops: RgbaColor[] | null;
}

/**
 * Remonte l'arbre DOM à partir du parent de `el` pour détecter tout fond d'ancêtre
 * qui affecterait le fond effectif de l'élément.
 * - S'arrête si un fond solide (alpha ≥ 0.85) est trouvé : il protège l'élément
 * - Un gradient pur (pas de url()) est parsé en stops analysables
 * - Une image url() est signalée comme `hasBgUrl`
 */
function analyzeAncestorBackgrounds(el: unknown, cssom: CSSOMInstance): AncestorBgInfo {
  let node: unknown = cssom.parentElement(el);
  while (node && cssom.isElement(node)) {
    const cs = cssom.getComputedStyle(node);
    // Solid ancestor bg shields from any bg-image further up the tree
    const bgColor = parseColorImpl(cs['background-color'] ?? null);
    if (bgColor && !isTransparent(bgColor) && bgColor.a >= 0.85) {
      return { hasBgUrl: false, gradientStops: null };
    }
    const bgImg = (cs['background-image'] as string | undefined)?.trim();
    if (bgImg && bgImg !== 'none') {
      if (bgImg.includes('url(')) {
        return { hasBgUrl: true, gradientStops: null };
      }
      // Pure CSS gradient — attempt to parse stops
      const stops = parseGradientStops(bgImg);
      return { hasBgUrl: false, gradientStops: stops };
    }
    node = cssom.parentElement(node);
  }
  return { hasBgUrl: false, gradientStops: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution du fond effectif (remonte l'arbre DOM via le CSSOM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache de fonds effectifs partagé sur la durée d'un audit de page.
 * Clé = nœud DOM de départ ; valeur = fond résolu (déterministe pour un cssom + opts fixés).
 * Élimine les remontées d'ascendance redondantes entre éléments frères : sur une page
 * dense (e-commerce, doc), le même parent est résolu des dizaines de fois sinon.
 */
export type BgCache = Map<unknown, RgbaColor>;

export function resolveEffectiveBackground(
  el: unknown,
  cssom: CSSOMInstance,
  opts: ResolveBackgroundOptions = {},
  cache?: BgCache,
): RgbaColor {
  const cached = cache?.get(el);
  if (cached !== undefined) return cached;

  const defaultBg: RgbaColor = opts.defaultBg ?? { r: 255, g: 255, b: 255, a: 1 };
  const useOpacity = opts.useOpacity !== false;

  const layers: RgbaColor[] = [];
  let node: unknown = el;

  while (node && cssom.isElement(node)) {
    const cs = cssom.getComputedStyle(node);
    // Axe 4 : display:contents retire l'élément du rendu — son background-color ne s'applique pas.
    if ((cs['display'] as string | undefined)?.trim() === 'contents') {
      node = cssom.parentElement(node);
      continue;
    }
    let bg = parseColor(cs['background-color']) ?? { r: 0, g: 0, b: 0, a: 0 };

    if (useOpacity) {
      const op = Number.parseFloat(cs['opacity']);
      if (!Number.isNaN(op)) bg = { ...bg, a: bg.a * op };
    }

    if (!isTransparent(bg)) {
      layers.push(bg);
      if (bg.a >= 1) break;
    }
    node = cssom.parentElement(node);
  }

  // Les couches sont fusionnées de la plus lointaine à la plus proche : c'est
  // l'ordre de composition d'un navigateur.
  let base = defaultBg;
  for (const layer of [...layers].reverse()) base = blendOver(layer, base);
  cache?.set(el, base);
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contraste WCAG — délégué à `color.ts`
// ─────────────────────────────────────────────────────────────────────────────

/** Ratio de contraste WCAG 2.x. Re-export de `color.ts` (source unique). */
export const contrastRatio = contrastRatioImpl;

export function evaluateElementContrast(
  el: unknown,
  cssom: CSSOMInstance,
  opts: ResolveBackgroundOptions = {},
  cache?: BgCache,
): ContrastElementResult {
  const cs = cssom.getComputedStyle(el);
  const ownBgImage = (cs['background-image'] as string | undefined)?.trim();
  const hasOwnBgImage = !!(ownBgImage && ownBgImage !== 'none');

  // Distinguish: url()-based background vs pure CSS gradient
  const hasBgUrl = hasOwnBgImage && ownBgImage.includes('url(');

  // Analyze ancestors for bg-image or gradient (only when FP_PROPAGATE_ANCESTOR_BG_IMAGE is on)
  const ancestorBg: AncestorBgInfo = FP_PROPAGATE_ANCESTOR_BG_IMAGE
    ? analyzeAncestorBackgrounds(el, cssom)
    : { hasBgUrl: false, gradientStops: null };

  // Element's own CSS opacity (creates a compositing layer affecting both bg and fg)
  const rawOpacity = parseFloat(cs['opacity'] ?? '1');
  const elementOpacity = isNaN(rawOpacity) ? 1 : Math.min(1, Math.max(0, rawOpacity));

  // Effective background from solid bg-color chain (ignores bg-image layers)
  let bg = resolveEffectiveBackground(el, cssom, opts, cache);

  // Lazily compute the background of the parent (needed for gradient & opacity fixes)
  let _parentBg: RgbaColor | undefined;
  const getParentBg = (): RgbaColor => {
    if (_parentBg !== undefined) return _parentBg;
    const parentNode = cssom.parentElement(el);
    const result: RgbaColor =
      parentNode && cssom.isElement(parentNode)
        ? resolveEffectiveBackground(parentNode, cssom, opts, cache)
        : (opts.defaultBg ?? { r: 255, g: 255, b: 255, a: 1 });
    _parentBg = result;
    return result;
  };

  // Collect gradient stops: from element's own gradient OR nearest ancestor gradient
  let gradientBlendedStops: RgbaColor[] | null = null;

  if (hasOwnBgImage && !hasBgUrl) {
    // Element has its own CSS gradient
    const stops = parseGradientStops(ownBgImage);
    if (stops && stops.length >= 1) {
      // Apply element opacity: gradient is within the element's compositing layer
      const effectiveStops =
        elementOpacity < 1 ? stops.map(s => ({ ...s, a: s.a * elementOpacity })) : stops;
      // bg = resolveEffectiveBackground(el) already incorporates el's background-color as base
      gradientBlendedStops = effectiveStops.map(stop => blendOverImpl(stop, bg));
    }
  } else if (ancestorBg.gradientStops && ancestorBg.gradientStops.length >= 1) {
    // Nearest ancestor has a parseable gradient — use as the effective background
    // No element opacity applied here: the ancestor gradient is behind the element's layer
    gradientBlendedStops = ancestorBg.gradientStops.map(stop => blendOverImpl(stop, bg));
  }

  // hasBgImage: true only for non-analyzable backgrounds (url() or unparseable gradient)
  const hasBgImage =
    hasBgUrl ||
    (hasOwnBgImage && !hasBgUrl && gradientBlendedStops === null) ||
    ancestorBg.hasBgUrl;

  // Compute fg text color
  let fg = parseColor(cs['color']) ?? { r: 0, g: 0, b: 0, a: 1 };

  // Blend semi-transparent text color against current bg
  if (fg.a < 1) fg = blendOver(fg, bg);

  // Apply element's own opacity to fg: CSS opacity composites the whole rendering layer,
  // so text painted at full opacity within the element becomes fg@opacity over the parent bg.
  if (elementOpacity < 1 && fg.a > 0) {
    fg = blendOver({ ...fg, a: fg.a * elementOpacity }, getParentBg());
  }

  // For parseable gradient: select worst-case stop (min contrast with fg) as effective bg
  if (gradientBlendedStops !== null) {
    let worstRatio = Infinity;
    let worstBg = gradientBlendedStops[0]!;
    for (const blended of gradientBlendedStops) {
      const r = contrastRatioImpl(fg, blended);
      if (r < worstRatio) {
        worstRatio = r;
        worstBg = blended;
      }
    }
    bg = worstBg;
  }

  const ratio = contrastRatioImpl(fg, bg);
  const sizePx = Number.parseFloat(cs['font-size']) || 16;
  const weight = Number.parseInt(cs['font-weight'], 10) || 400;
  const isLarge = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);

  const sameColorFp =
    FP_SILENCE_RATIO_ONE &&
    Math.round(fg.r) === Math.round(bg.r) &&
    Math.round(fg.g) === Math.round(bg.g) &&
    Math.round(fg.b) === Math.round(bg.b);

  return {
    ratio: Math.round(ratio * 100) / 100,
    fg,
    bg,
    isLarge,
    hasBgImage,
    needsManualReview: hasBgImage || sameColorFp,
    AA: ratio >= (isLarge ? 3 : 4.5),
    AAA: ratio >= (isLarge ? 4.5 : 7),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée principal
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SELECTOR = 'p,a,span,li,h1,h2,h3,h4,h5,h6,button,label,td,th';

/**
 * Analyse une page complète et rend un résultat de contraste par élément texte.
 *
 * `source` accepte un document déjà analysé : l'analyseur passe la page parsée
 * par l'orchestrateur plutôt que son HTML, ce qui évite un second parse complet.
 *
 * @param opts.fetchExternal  Défaut : false — ne pas appeler d'URLs externes (SSRF)
 */
export async function auditPageContrast(
  source: string | CheerioAPI,
  opts: AuditPageOptions = {},
): Promise<AuditPageResult> {
  const { baseUrl, fetchCss, selector = DEFAULT_SELECTOR, maxElements = 400 } = opts;

  const external = await fetchExternalCss(source, { baseUrl, fetchImpl: fetchCss });

  const cssom = buildCSSOM(source, { externalCss: external.sheets });

  // Axe 6 : un thème sombre déclaré bascule le fond par défaut sur le noir,
  // sans quoi un texte clair parfaitement lisible serait rapporté illisible.
  // La détection se fait sur le DOM et non sur le HTML brut : chercher
  // « color-scheme : dark » dans la source entière trouverait aussi ces mots
  // dans le TEXTE d'une page qui parle de thèmes sombres.
  const defaultBg: RgbaColor = hasDarkScheme(cssom.$)
    ? { r: 0, g: 0, b: 0, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };

  // Cache des fonds effectifs partagé sur tout l'audit : les éléments frères
  // partagent leur chaîne d'ascendance, dont la résolution n'est faite qu'une fois.
  const bgCache: BgCache = new Map();

  const results: AuditElementResult[] = [];
  let truncated = false;

  // Cheerio lit `false` comme un « casser la boucle » et toute autre valeur
  // comme un « passer au suivant » : le rappel rend donc TOUJOURS un booléen,
  // pour que l'intention de chaque sortie se lise sur la ligne même.
  cssom.$(selector).each((_i: number, el: unknown): boolean => {
    // Axe 5 : plafond d'éléments.
    if (results.length >= maxElements) {
      truncated = true;
      return false;
    }

    const $el = cssom.$(el as Parameters<typeof cssom.$>[0]);
    if ($el.text().trim().length === 0) return true;

    // Guard : ignore les éléments visuellement cachés.
    const cs = cssom.getComputedStyle(el);
    if (cs['display'] === 'none' || cs['visibility'] === 'hidden') return true;

    // Axe 1 : opacity:0 → élément invisible, non audité.
    const opacityVal = parseFloat(cs['opacity']);
    if (!isNaN(opacityVal) && opacityVal <= 0) return true;

    if (FP_SKIP_INDIRECT_TEXT_CONTAINERS) {
      type CheerioNode = { type?: string; data?: string };
      const hasDirectText = ($el.contents().toArray() as CheerioNode[]).some(
        n => n.type === 'text' && /\S/.test(n.data ?? ''),
      );
      if (!hasDirectText) return true;
    }

    const id = $el.attr('id') || undefined;
    const rawClass = $el.attr('class')?.trim();
    const classes = rawClass
      ? rawClass
          .split(/\s+/)
          .slice(0, 3)
          .map(c => `.${c}`)
          .join('')
      : undefined;

    results.push({
      tag: (el as { name?: string }).name ?? 'unknown',
      text: $el.text().trim().slice(0, 60),
      id,
      classes,
      // Axe 6 : passe le fond par défaut (blanc ou noir selon color-scheme).
      ...evaluateElementContrast(el, cssom, { defaultBg }, bgCache),
    });

    return true;
  });

  return {
    elements: results,
    truncated,
    externalSheets: { declared: external.declared, loaded: external.loaded },
  };
}

/**
 * La page déclare-t-elle un thème sombre ?
 *
 * Trois sources, dans l'ordre où un navigateur les lit : la balise `meta`, les
 * feuilles embarquées, puis les styles en ligne.
 */
function hasDarkScheme($: CheerioAPI): boolean {
  const declared = $('meta[name="color-scheme"]').attr('content');
  if (declared && /\bdark\b/i.test(declared)) return true;

  const pattern = /color-scheme\s*:\s*(?:[^;{]*\s)?dark\b/i;
  return (
    $('style')
      .toArray()
      .some(node => pattern.test($(node).text())) ||
    $('[style]')
      .toArray()
      .some(node => pattern.test($(node).attr('style') ?? ''))
  );
}
