/**
 * micro-cssom.ts — Moteur CSSOM minimal sans dépendance ajoutée.
 *
 * Réutilise cheerio (déjà présent dans le projet) pour le parsing HTML et le
 * matching de sélecteurs, et implémente :
 *   - Parsing des feuilles CSS (<style>/externes, !important)
 *   - Spécificité (gère :is/:not/:where/:has) + cascade complète + inline
 *   - Héritage des propriétés héritées
 *   - Mots-clés inherit/initial/unset/currentColor
 *   - Unités de font-size (px/pt/em/rem/%/keywords)
 *   - Feuille User-Agent minimale
 *   - Custom properties + résolution var(--x, fallback) avec héritage
 *   - @media évalués selon un viewport (mode breakpoint)
 *
 * Périmètre : analyse statique (QA, contraste). Pas de layout, pas de :hover.
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

/**
 * Récupération d'une feuille externe — INJECTÉE.
 *
 * Le moteur ne sort jamais sur le réseau de lui-même : l'appelant lui fournit
 * une fonction, laquelle passe par la politique SSRF. Câbler la sortie ici
 * donnerait au moteur CSS une porte dérobée vers le réseau, hors de la seule
 * sonde autorisée.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types internes
// ─────────────────────────────────────────────────────────────────────────────

/** Forme structurelle d'un nœud domhandler — évite une dépendance directe. */
interface DomNode {
  type: string;
  name: string;
  attribs: Record<string, string>;
  parent: DomNode | null;
}

type Specificity = [number, number, number];

interface DeclEntry {
  value: string;
  important: boolean;
}

type Declarations = Record<string, DeclEntry>;

interface ParsedRule {
  selectorText: string;
  declarations: Declarations;
  media: string[];
  /** Nom de couche @layer (chaîne plate par ordre d'apparition) ; undefined = non-layered. */
  layer?: string;
}

interface RuleEntry {
  declarations: Declarations;
  specificity: Specificity;
  order: number;
  inline?: boolean;
  /** Index numérique de la couche @layer ; undefined = non-layered. */
  layerIndex?: number;
}

interface CandidateEntry {
  value: string;
  important: boolean;
  inline: boolean;
  specificity: Specificity;
  order: number;
  /** Index de couche @layer ; undefined = non-layered (prioritaire en normal). */
  layerIndex?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types publics exportés
// ─────────────────────────────────────────────────────────────────────────────

export interface Viewport {
  width: number;
  height: number;
  type?: string;
  rootEm?: number;
  features?: Record<string, string | boolean>;
}

/**
 * Style calculé d'un élément.
 *
 * Le jeu de propriétés est FERMÉ : le moteur n'en suit que ce dont la mesure
 * de contraste a besoin. Le type qui en découle laisse lire un style par clé
 * calculée sans jamais retomber sur `unknown`, donc sans conversion défensive
 * dans la cascade.
 */
export type ComputedStyle = Record<TrackedProperty, string> & {
  /** Taille de police résolue en pixels — sert de base aux unités relatives. */
  _fontSizePx: number;
  /** Registre des custom properties visibles depuis cet élément. */
  _vars: Map<string, string> | null;
};

export interface CSSOMInstance {
  $: CheerioAPI;
  root: DomNode | null;
  getComputedStyle(node: unknown): ComputedStyle;
  isElement(node: unknown): node is DomNode;
  parentElement(node: unknown): DomNode | null;
}

export interface BuildOptions {
  externalCss?: Record<string, string>;
  useUaStylesheet?: boolean;
  viewport?: Viewport | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Propriétés suivies + héritage + valeurs initiales
// ─────────────────────────────────────────────────────────────────────────────

const TRACKED = [
  'color',
  'background-color',
  'background-image',
  'opacity',
  'font-size',
  'font-weight',
  'font-style',
  'visibility',
  'display',
] as const;

/** Une des propriétés suivies — et rien d'autre. */
export type TrackedProperty = (typeof TRACKED)[number];

const INHERITED = new Set<TrackedProperty>([
  'color',
  'font-size',
  'font-weight',
  'font-style',
  'visibility',
]);

const INITIAL: Record<TrackedProperty, string> = {
  color: 'rgb(0, 0, 0)',
  'background-color': 'transparent',
  'background-image': 'none',
  opacity: '1',
  'font-size': '16px',
  'font-weight': '400',
  'font-style': 'normal',
  visibility: 'visible',
  display: 'inline',
};

const UA_STYLESHEET = `
  body { display: block; }
  h1,h2,h3,h4,h5,h6,b,strong { font-weight: 700; }
  h1 { font-size: 32px; } h2 { font-size: 24px; } h3 { font-size: 18.72px; }
  h4 { font-size: 16px; } h5 { font-size: 13.28px; } h6 { font-size: 10.72px; }
  i,em { font-style: italic; }
  div,p,section,article,header,footer,nav,ul,ol,li,table { display: block; }
`;

const ROOT_DEFAULTS: ComputedStyle = Object.freeze({
  color: 'rgb(0, 0, 0)',
  'background-color': 'transparent',
  'background-image': 'none',
  opacity: '1',
  'font-size': '16px',
  'font-weight': '400',
  'font-style': 'normal',
  visibility: 'visible',
  display: 'block',
  _fontSizePx: 16,
  _vars: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Parsing CSS
// ─────────────────────────────────────────────────────────────────────────────

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function readBlock(css: string, openIdx: number): { block: string; end: number } {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      return { block: css.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return { block: css.slice(openIdx + 1), end: css.length };
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  if (buf.trim() || out.length) out.push(buf);
  return out;
}

function parseDeclarations(text: string): Declarations {
  const out: Declarations = {};
  for (const decl of splitTopLevel(text, ';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const rawProp = decl.slice(0, idx).trim();
    // Les custom properties sont sensibles à la casse.
    const prop = rawProp.startsWith('--') ? rawProp : rawProp.toLowerCase();
    let value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    let important = false;
    const m = value.match(/!\s*important\s*$/i);
    if (m) {
      important = true;
      value = value.slice(0, m.index).trim();
    }
    out[prop] = { value, important };
  }
  return out;
}

interface ParseCtx {
  media: string[];
  layer?: string;
  /** Ordre d'apparition des couches @layer (nom → index), partagé pour toute la feuille. */
  layerOrder: Map<string, number>;
  /** Compteur de couches anonymes, partagé par référence. */
  anon: { n: number };
}

const joinLayer = (parent: string | undefined, name: string): string =>
  parent ? `${parent}.${name}` : name;

function registerLayer(order: Map<string, number>, name: string): void {
  if (!order.has(name)) order.set(name, order.size);
}

function parseStylesheet(css: string, ctx?: Partial<ParseCtx>): ParsedRule[] {
  const c: ParseCtx = {
    media: ctx?.media ?? [],
    layer: ctx?.layer,
    layerOrder: ctx?.layerOrder ?? new Map<string, number>(),
    anon: ctx?.anon ?? { n: 0 },
  };
  css = stripComments(css);
  const rules: ParsedRule[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i] ?? '')) i++;
    if (i >= css.length) break;

    if (css[i] === '@') {
      let j = i;
      while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
      const prelude = css.slice(i, j).trim();
      const name = (prelude.split(/\s+/)[0] ?? '').toLowerCase();
      // Forme instruction « @layer a, b, c; » → fixe l'ordre des couches.
      if (css[j] === ';') {
        if (name === '@layer') {
          for (const n of prelude.slice(6).split(',')) {
            const nm = n.trim();
            if (nm) registerLayer(c.layerOrder, joinLayer(c.layer, nm));
          }
        }
        i = j + 1;
        continue;
      }
      const { block, end } = readBlock(css, j);
      if (name === '@media') {
        const cond = prelude.slice(6).trim();
        rules.push(...parseStylesheet(block, { ...c, media: cond ? [...c.media, cond] : c.media }));
      } else if (name === '@layer') {
        // Forme bloc « @layer name { … } » ou anonyme « @layer { … } ».
        const decl = prelude.slice(6).trim();
        const layerName = decl
          ? joinLayer(c.layer, decl)
          : joinLayer(c.layer, `#anon${c.anon.n++}`);
        registerLayer(c.layerOrder, layerName);
        rules.push(...parseStylesheet(block, { ...c, layer: layerName }));
      } else if (name === '@supports' || name === '@container') {
        rules.push(...parseStylesheet(block, c));
      }
      i = end;
    } else {
      let j = i;
      while (j < css.length && css[j] !== '{') j++;
      if (j >= css.length) break;
      const selectorText = css.slice(i, j).trim();
      const { block, end } = readBlock(css, j);
      if (selectorText) {
        rules.push({
          selectorText,
          declarations: parseDeclarations(block),
          media: c.media,
          layer: c.layer,
        });
      }
      i = end;
    }
  }
  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media queries
// ─────────────────────────────────────────────────────────────────────────────

function lengthToPx(str: string, vp: Viewport): number {
  const m = String(str)
    .trim()
    .match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem)?$/i);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1] ?? '');
  switch ((m[2] ?? 'px').toLowerCase()) {
    case 'pt':
      return (n * 96) / 72;
    case 'em':
    case 'rem':
      return n * (vp.rootEm ?? 16);
    default:
      return n;
  }
}

function compareOp(a: number, op: string, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '=':
      return a === b;
    default:
      return false;
  }
}

function evalFeature(part: string, vp: Viewport): boolean {
  const inner = part.replace(/^\(|\)$/g, '').trim();
  let m: RegExpMatchArray | null;
  /** Groupe de capture par rang — un groupe qui a filé est toujours présent. */
  const group = (index: number): string => m?.[index] ?? '';

  if ((m = inner.match(/^(min|max)-(width|height)\s*:\s*(.+)$/i))) {
    const target = lengthToPx(m[3] ?? '', vp);
    const val = (m[2] ?? '').toLowerCase() === 'width' ? vp.width : vp.height;
    return (m[1] ?? '').toLowerCase() === 'min' ? val >= target : val <= target;
  }
  if ((m = inner.match(/^(.+?)\s*(<=|<)\s*(width|height)\s*(<=|<)\s*(.+)$/i))) {
    const val = group(3).toLowerCase() === 'width' ? vp.width : vp.height;
    return (
      compareOp(lengthToPx(group(1), vp), group(2), val) &&
      compareOp(val, group(4), lengthToPx(group(5), vp))
    );
  }
  if ((m = inner.match(/^(width|height)\s*(<=|>=|<|>|=)\s*(.+)$/i))) {
    const val = group(1).toLowerCase() === 'width' ? vp.width : vp.height;
    return compareOp(val, group(2), lengthToPx(group(3), vp));
  }
  if ((m = inner.match(/^(width|height)\s*:\s*(.+)$/i))) {
    const val = group(1).toLowerCase() === 'width' ? vp.width : vp.height;
    return val === lengthToPx(group(2), vp);
  }
  if ((m = inner.match(/^([\w-]+)\s*:\s*(.+)$/))) {
    return (
      String(vp.features?.[group(1).toLowerCase()] ?? '').toLowerCase() ===
      group(2).trim().toLowerCase()
    );
  }
  return !!vp.features?.[inner.toLowerCase()];
}

function evalSingleQuery(q: string, vp: Viewport): boolean {
  let negate = false;
  q = q.replace(/^\s*only\s+/i, '');
  if (/^\s*not\s+/i.test(q)) {
    negate = true;
    q = q.replace(/^\s*not\s+/i, '');
  }
  const parts = q
    .split(/\s+and\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
  let ok = true;
  for (const part of parts) {
    if (part.startsWith('(')) ok = ok && evalFeature(part, vp);
    else {
      const type = part.toLowerCase();
      if (type !== 'all') ok = ok && type === (vp.type ?? 'screen');
    }
  }
  return negate ? !ok : ok;
}

/** Évalue une media query (liste séparée par virgules = OU) contre un viewport. */
export function matchMedia(query: string, vp: Viewport): boolean {
  return splitTopLevel(query, ',').some(q => q.trim() && evalSingleQuery(q.trim(), vp));
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution des var()
// ─────────────────────────────────────────────────────────────────────────────

function splitVarArgs(inner: string): { name: string; fallback: string | null } {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      return { name: inner.slice(0, i).trim(), fallback: inner.slice(i + 1).trim() };
    }
  }
  return { name: inner.trim(), fallback: null };
}

/**
 * Substitue récursivement var(--name, fallback) à partir d'un registre Map.
 * Renvoie '' si non résolvable.
 */
export function substituteVars(
  value: string,
  registry: Map<string, string>,
  seen: Set<string> = new Set(),
): string {
  if (!value || !value.includes('var(')) return value;
  let result = '';
  let i = 0;
  while (i < value.length) {
    const idx = value.indexOf('var(', i);
    if (idx === -1) {
      result += value.slice(i);
      break;
    }
    result += value.slice(i, idx);

    let depth = 0;
    let j = idx + 3;
    const start = j;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')' && --depth === 0) break;
    }
    const { name, fallback } = splitVarArgs(value.slice(start + 1, j));

    let resolved: string;
    if (registry.has(name) && !seen.has(name)) {
      resolved = substituteVars(registry.get(name)!, registry, new Set([...seen, name]));
    } else if (fallback != null) {
      resolved = substituteVars(fallback, registry, seen);
    } else {
      resolved = '';
    }
    result += resolved;
    i = j + 1;
  }
  return result.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Spécificité
// ─────────────────────────────────────────────────────────────────────────────

function compareSpec(x: Specificity, y: Specificity): number {
  // Comparaison poste par poste, du plus fort au plus faible — la dimension
  // est portée par le type `Specificity`, d'où l'absence de boucle indexée.
  const [xa, xb, xc] = x;
  const [ya, yb, yc] = y;
  if (xa !== ya) return xa - ya;
  if (xb !== yb) return xb - yb;
  return xc - yc;
}

/** Sépare une liste de sélecteurs au niveau supérieur (virgules hors parenthèses/crochets). */
function splitSelectorList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  if (buf.trim() || out.length) out.push(buf);
  return out;
}

/**
 * Spécificité [a, b, c] = [#id, classes/attrs/pseudo-classes, types/pseudo-éléments].
 *
 * Gère les pseudo-classes fonctionnelles **imbriquées** via extraction à parenthèses
 * équilibrées (récursion), contrairement à l'ancienne approche regex à un seul niveau :
 *   - :where(…)            → 0 (n'ajoute rien)
 *   - :is/:matches/:not/:has(…) → spécificité MAX parmi les arguments
 *   - :nth-child(… of S)   → +1 (b) + spécificité de S
 *   - autres :fn(…)        → +1 (b)
 */
export function specificity(selector: string): Specificity {
  let a = 0,
    b = 0,
    c = 0;

  // 1) Extraire les pseudos fonctionnels (parenthèses équilibrées) et retirer leur contenu.
  let stripped = '';
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === ':') {
      let j = i + 1;
      const isElement = selector[j] === ':';
      if (isElement) j++;
      const nameStart = j;
      while (j < selector.length && /[\w-]/.test(selector[j] ?? '')) j++;
      const fnName = selector.slice(nameStart, j).toLowerCase();
      if (selector[j] === '(') {
        let depth = 0,
          k = j;
        for (; k < selector.length; k++) {
          if (selector[k] === '(') depth++;
          else if (selector[k] === ')') {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          }
        }
        const args = selector.slice(j + 1, k - 1);
        if (isElement) {
          // pseudo-élément fonctionnel (::slotted, ::part…) → c, args ignorés.
          c++;
        } else if (fnName === 'where') {
          // n'ajoute rien.
        } else if (
          fnName === 'is' ||
          fnName === 'matches' ||
          fnName === 'not' ||
          fnName === 'has'
        ) {
          let best: Specificity = [0, 0, 0];
          for (const arg of splitSelectorList(args)) {
            const sp = specificity(arg.trim());
            if (compareSpec(sp, best) > 0) best = sp;
          }
          a += best[0];
          b += best[1];
          c += best[2];
        } else if (fnName === 'nth-child' || fnName === 'nth-last-child') {
          b++; // la pseudo-classe elle-même
          const ofMatch = args.match(/\bof\b(.+)$/i);
          if (ofMatch) {
            const sp = specificity((ofMatch[1] ?? '').trim());
            a += sp[0];
            b += sp[1];
            c += sp[2];
          }
        } else {
          b++; // autre pseudo-classe fonctionnelle
        }
        i = k;
        continue;
      }
    }
    stripped += ch;
    i++;
  }

  // 2) Compter le reste (sans pseudos fonctionnels).
  let s = ` ${stripped} `;
  s = s.replace(/#[\w-]+/g, () => {
    a++;
    return ' ';
  });
  s = s.replace(/\[[^\]]*\]/g, () => {
    b++;
    return ' ';
  });
  s = s.replace(/\.[\w-]+/g, () => {
    b++;
    return ' ';
  });
  s = s.replace(/::[\w-]+/g, () => {
    c++;
    return ' ';
  });
  s = s.replace(/:(?:before|after|first-line|first-letter)\b/gi, () => {
    c++;
    return ' ';
  });
  s = s.replace(/:[\w-]+/g, () => {
    b++;
    return ' ';
  });
  s.replace(/[a-z][\w-]*/gi, () => {
    c++;
    return ' ';
  });
  return [a, b, c];
}

// ─────────────────────────────────────────────────────────────────────────────
// Raccourcis (best-effort)
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_TOKEN =
  /(rgba?\([^)]*\)|hsla?\([^)]*\)|var\([^)]*\)|#[0-9a-f]{3,8}|\b(?:transparent|currentcolor)\b)/i;

function expandShorthands(decls: Declarations): Declarations {
  const out: Declarations = { ...decls };
  const bg = out['background'];
  if (bg) {
    if (/url\(|gradient\(/i.test(bg.value) && out['background-image'] === undefined) {
      out['background-image'] = { value: bg.value, important: bg.important };
    }
    const m = bg.value.match(COLOR_TOKEN);
    if (m && out['background-color'] === undefined) {
      out['background-color'] = { value: m[1] ?? '', important: bg.important };
    }
  }
  const font = out['font'];
  if (font && out['font-size'] === undefined) {
    const sizeM = font.value.match(/(\d*\.?\d+)(px|pt|em|rem|%)/i);
    if (sizeM) out['font-size'] = { value: sizeM[0], important: font.important };
    const weightM = font.value.match(/\b(bold|[1-9]00)\b/i);
    if (weightM && out['font-weight'] === undefined) {
      out['font-weight'] = { value: weightM[1] ?? '', important: font.important };
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution des valeurs
// ─────────────────────────────────────────────────────────────────────────────

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9.6,
  'x-small': 12,
  small: 13.33,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
};

function resolveFontSize(raw: string | undefined, parentPx: number, rootPx: number): number {
  if (!raw) return parentPx;
  const v = raw.trim().toLowerCase();
  if (v === 'inherit') return parentPx;
  if (v === 'initial') return 16;
  if (FONT_SIZE_KEYWORDS[v] != null) return FONT_SIZE_KEYWORDS[v];
  if (v === 'larger') return parentPx * 1.2;
  if (v === 'smaller') return parentPx / 1.2;

  // Axe 2 : clamp(min, preferred, max) — approximation conservative : résout avec le minimum.
  // Pattern courant en fluid typography (Tailwind, Bootstrap 5.3+).
  if (v.startsWith('clamp(')) {
    let depth = 0;
    let commaIdx = -1;
    for (let i = 6; i < v.length; i++) {
      if (v[i] === '(') depth++;
      else if (v[i] === ')') depth--;
      else if (v[i] === ',' && depth === 0) {
        commaIdx = i;
        break;
      }
    }
    return commaIdx >= 0
      ? resolveFontSize(v.slice(6, commaIdx).trim(), parentPx, rootPx)
      : parentPx;
  }

  // Axe 2 : vw/vh — approximation viewport 1920×1080 (correspond au DEFAULT_VIEWPORT).
  const vwM = v.match(/^(-?\d*\.?\d+)vw$/);
  if (vwM) return (Number.parseFloat(vwM[1] ?? '') / 100) * 1920;
  const vhM = v.match(/^(-?\d*\.?\d+)vh$/);
  if (vhM) return (Number.parseFloat(vhM[1] ?? '') / 100) * 1080;

  const m = v.match(/^(-?\d*\.?\d+)(px|pt|em|rem|%)?$/);
  if (!m) return parentPx;
  const n = Number.parseFloat(m[1] ?? '');
  switch (m[2]) {
    case 'pt':
      return (n * 96) / 72;
    case 'em':
      return n * parentPx;
    case 'rem':
      return n * rootPx;
    case '%':
      return (n / 100) * parentPx;
    default:
      return n;
  }
}

function resolveFontWeight(raw: string | undefined, parentWeight: number): number {
  if (!raw) return parentWeight;
  const v = raw.trim().toLowerCase();
  if (v === 'inherit') return parentWeight;
  if (v === 'normal' || v === 'initial') return 400;
  if (v === 'bold') return 700;
  if (v === 'bolder') return parentWeight < 700 ? 700 : 900;
  if (v === 'lighter') return parentWeight > 400 ? 400 : 100;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? parentWeight : n;
}

function resolveKeyword(prop: TrackedProperty, raw: string, parentComputed: ComputedStyle): string {
  if (raw === 'inherit') return parentComputed[prop];
  if (raw === 'initial') return INITIAL[prop];
  if (raw === 'unset' || raw === 'revert') {
    return INHERITED.has(prop) ? parentComputed[prop] : INITIAL[prop];
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade
// ─────────────────────────────────────────────────────────────────────────────

function priorityRank(c: CandidateEntry): number[] {
  // Couche @layer (Cascade 5) : pour les déclarations normales, le non-layered gagne
  // et la couche déclarée plus tard gagne ; pour !important, l'ordre s'inverse.
  const layered = c.layerIndex != null;
  let layerScore: number;
  if (c.important) layerScore = layered ? -(c.layerIndex as number) : Number.NEGATIVE_INFINITY;
  else layerScore = layered ? (c.layerIndex as number) : Number.POSITIVE_INFINITY;
  return [
    c.important ? 1 : 0,
    c.inline ? 1 : 0,
    layerScore,
    ...c.specificity,
    c.order === Infinity ? Number.MAX_SAFE_INTEGER : c.order,
  ];
}

function cascadeWins(cand: CandidateEntry, cur: CandidateEntry): boolean {
  const a = priorityRank(cand);
  const b = priorityRank(cur);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction du CSSOM
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinelle : var() déclarée mais non résolvable — distinct de "propriété absente". */
const VAR_UNRESOLVED = '__var_unresolved__';

/**
 * Viewport par défaut pour l'analyse statique : écran desktop en mode clair.
 * Garantit que les règles @media (prefers-color-scheme: dark), @media print, etc.
 * sont correctement ignorées, évitant que des valeurs dark-mode ne polluent
 * la chaîne _vars et faussent les couleurs calculées.
 */
const DEFAULT_VIEWPORT: Viewport = {
  width: 1920,
  height: 1080,
  type: 'screen',
  rootEm: 16,
  features: {
    'prefers-color-scheme': 'light',
    'prefers-reduced-motion': 'no-preference',
    'prefers-contrast': 'no-preference',
  },
};

/**
 * Construit le CSSOM d'un document.
 *
 * `source` accepte un document DÉJÀ analysé : l'analyseur de contraste reçoit
 * la page parsée par l'orchestrateur, et la reparser coûterait un second
 * `cheerio.load` complet — le poste le plus cher du critère sur une grande
 * page. Le moteur ne modifie rien du document, le partager est sans risque.
 */
export function buildCSSOM(source: string | CheerioAPI, opts: BuildOptions = {}): CSSOMInstance {
  const { externalCss = {}, useUaStylesheet = true, viewport = DEFAULT_VIEWPORT } = opts;
  const $ = typeof source === 'string' ? cheerio.load(source) : source;

  /* 1. Feuilles dans l'ordre du document */
  const sheets: string[] = [];
  if (useUaStylesheet) sheets.push(UA_STYLESHEET);
  $('style, link[rel~="stylesheet"]').each((_i: number, rawNode: unknown) => {
    const node = rawNode as DomNode;
    if (node.name === 'style') {
      sheets.push($(rawNode as Parameters<typeof $>[0]).text());
    } else {
      const href = node.attribs?.['href'];
      const css = href && (externalCss[href] ?? externalCss[String(href).trim()]);
      if (css) sheets.push(css);
    }
  });

  /* 2. Parsing + indexation par nœud (filtrage media si viewport) */
  const nodeRules = new Map<object, RuleEntry[]>();
  // Registre global des custom properties de palette (:root/html/body uniquement).
  // Fallback conforme : ces définitions s'appliquent à tout élément (ancêtres de tous),
  // contrairement à une collecte « toutes règles » qui injecterait des valeurs erronées.
  const globalCustomVars = new Map<string, string>();
  // Ordre des couches @layer, partagé entre toutes les feuilles (ordre document).
  const layerOrder = new Map<string, number>();
  const anon = { n: 0 };
  let order = 0;

  for (const css of sheets) {
    for (const rule of parseStylesheet(css, { layerOrder, anon })) {
      if (viewport && rule.media.length) {
        if (!rule.media.every(cond => matchMedia(cond, viewport))) continue;
      }
      // Registre de palette : seuls :root / html / body font autorité.
      for (const sel of rule.selectorText.split(',')) {
        const s = sel.trim();
        if (s === ':root' || s === 'html' || s === 'body') {
          for (const prop in rule.declarations) {
            if (prop.startsWith('--')) {
              const declaration = rule.declarations[prop];
              if (declaration) globalCustomVars.set(prop, declaration.value);
            }
          }
          break;
        }
      }
      const layerIndex = rule.layer != null ? layerOrder.get(rule.layer) : undefined;
      for (const sel of rule.selectorText.split(',')) {
        const selector = sel.trim();
        if (!selector) continue;
        const spec = specificity(selector);
        const ord = order++;
        let matched: unknown[];
        try {
          matched = $(selector).toArray();
        } catch {
          continue;
        }
        for (const rawNode of matched) {
          const node = rawNode as object;
          if (!nodeRules.has(node)) nodeRules.set(node, []);
          nodeRules
            .get(node)!
            .push({ declarations: rule.declarations, specificity: spec, order: ord, layerIndex });
        }
      }
    }
  }

  /* 3. Cascade pour un nœud → { prop: rawValue } */
  function resolveDeclarations(node: object): Record<string, string> {
    const domNode = node as DomNode;
    const entries: (RuleEntry & { inline?: boolean })[] = (nodeRules.get(node) ?? []).slice();
    const styleAttr = domNode.attribs?.['style'];
    if (styleAttr) {
      entries.push({
        declarations: parseDeclarations(styleAttr),
        specificity: [0, 0, 0],
        order: Infinity,
        inline: true,
      });
    }
    const winners: Record<string, CandidateEntry> = {};
    for (const e of entries) {
      const decls = expandShorthands(e.declarations);
      for (const prop in decls) {
        const declaration = decls[prop];
        if (!declaration) continue;
        const cand: CandidateEntry = {
          value: declaration.value,
          important: declaration.important,
          inline: !!e.inline,
          specificity: e.specificity,
          order: e.order,
          layerIndex: e.layerIndex,
        };
        if (!winners[prop] || cascadeWins(cand, winners[prop])) winners[prop] = cand;
      }
    }
    const out: Record<string, string> = {};
    for (const p in winners) {
      const winner = winners[p];
      if (winner) out[p] = winner.value;
    }
    return out;
  }

  /* 4. Style calculé (descendant, mémoïsé) */
  const cache = new Map<object, ComputedStyle>();
  const rootEl = ($('html').toArray()[0] ?? null) as DomNode | null;
  let rootFontSizePx = 16;

  function isElement(node: unknown): node is DomNode {
    if (!node || typeof node !== 'object') return false;
    const n = node as Partial<DomNode>;
    return n.type === 'tag' || n.type === 'script' || n.type === 'style';
  }

  function parentElement(node: unknown): DomNode | null {
    if (!node || typeof node !== 'object') return null;
    let p: unknown = (node as Partial<DomNode>).parent;
    while (p && !isElement(p)) p = (p as Partial<DomNode>).parent;
    return isElement(p) ? p : null;
  }

  function getComputedStyle(node: unknown): ComputedStyle {
    if (!isElement(node)) return { ...ROOT_DEFAULTS };
    const nodeObj = node as object;
    if (cache.has(nodeObj)) return cache.get(nodeObj)!;

    const parent = parentElement(node);
    const parentComputed: ComputedStyle = parent ? getComputedStyle(parent) : ROOT_DEFAULTS;

    const decls = resolveDeclarations(nodeObj);

    // Registre des custom properties : hérité du parent + propres au nœud.
    const vars = new Map<string, string>(parentComputed._vars ?? []);
    for (const p in decls) {
      const declaration = decls[p];
      if (p.startsWith('--') && declaration !== undefined) vars.set(p, declaration);
    }

    const get = (p: string): string | undefined => {
      const raw = decls[p];
      if (raw === undefined) return undefined;
      if (!raw.includes('var(')) return raw;
      const resolved = substituteVars(raw, vars);
      if (resolved) return resolved;
      // Fallback : registre global (toutes les custom properties des feuilles).
      // Couvre les cas où la propagation via _vars est incomplète
      // (sélecteurs complexes non matchés par cheerio, ex. sélecteurs Duda).
      const globalResolved = substituteVars(raw, globalCustomVars);
      if (globalResolved) return globalResolved;
      // Propriété déclarée mais var() non résolvable : sentinelle distincte de "absent".
      return VAR_UNRESOLVED;
    };

    // Les valeurs initiales servent de socle : toute propriété suivie a donc
    // une valeur, et la lecture par clé calculée reste une chaîne.
    const props: Record<TrackedProperty, string> = { ...INITIAL };

    const fsPx = resolveFontSize(get('font-size'), parentComputed._fontSizePx, rootFontSizePx);
    props['font-size'] = `${+fsPx.toFixed(2)}px`;

    props['font-weight'] = String(
      resolveFontWeight(
        get('font-weight'),
        Number.parseInt(parentComputed['font-weight'], 10) || 400,
      ),
    );

    for (const prop of TRACKED) {
      if (prop === 'font-size' || prop === 'font-weight') continue;
      const rawVal = get(prop);
      if (rawVal === undefined) {
        // Propriété non déclarée sur cet élément → héritage normal CSS.
        props[prop] = INHERITED.has(prop) ? parentComputed[prop] : INITIAL[prop];
        continue;
      }
      if (rawVal === VAR_UNRESOLVED) {
        // var() déclarée mais variable introuvable → valeur initiale CSS.
        // (CSS Custom Properties spec : "invalid at computed value time")
        // On n'hérite pas du parent pour ne pas masquer l'intention du style inline.
        props[prop] = INITIAL[prop];
        continue;
      }
      let resolved = resolveKeyword(prop, rawVal, parentComputed);
      if (/^currentcolor$/i.test(resolved)) {
        // `currentcolor` renvoie à la couleur de l'élément ; posée sur `color`
        // elle-même, elle vaut héritage — `color` est résolue en premier, les
        // autres propriétés lisent donc une valeur déjà arrêtée.
        resolved = prop === 'color' ? parentComputed.color : props.color;
      }
      props[prop] = resolved;
    }

    const result: ComputedStyle = { ...props, _fontSizePx: fsPx, _vars: vars };
    cache.set(nodeObj, result);
    return result;
  }

  if (rootEl) {
    rootFontSizePx = getComputedStyle(rootEl)._fontSizePx;
    cache.clear(); // recalcul propre avec le bon rootFontSizePx pour les rem
  }

  return { $, root: rootEl, getComputedStyle, isElement, parentElement };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feuilles externes (optionnel)
// ─────────────────────────────────────────────────────────────────────────────

type CssFetchImpl = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export async function fetchExternalCss(
  source: string | CheerioAPI,
  {
    baseUrl,
    // Aucun repli : sans fonction fournie, le moteur ne sort pas.
    fetchImpl,
  }: { baseUrl?: string; fetchImpl?: CssFetchImpl } = {},
): Promise<Record<string, string>> {
  if (!fetchImpl) return {};
  const $ = typeof source === 'string' ? cheerio.load(source) : source;
  const map: Record<string, string> = {};
  await Promise.all(
    $('link[rel~="stylesheet"][href]')
      .toArray()
      .map(async (rawNode: unknown) => {
        const node = rawNode as DomNode;
        const href = node.attribs?.['href'];
        if (!href) return;
        try {
          const url = new URL(href, baseUrl).href;
          const res = await fetchImpl(url);
          if (res.ok) map[href] = await res.text();
        } catch {
          /* feuille injoignable ou cible interdite (SSRF) — ignoré */
        }
      }),
  );
  return map;
}

/*
 * Limites connues (analyse statique QA)
 * ─────────────────────────────────────
 * - Pas de :hover/:focus/:active (sélecteurs dynamiques ignorés).
 * - var() : substitution textuelle + héritage + fallback + anti-cycle.
 *   calc()/env() NON évalués (laissés tels quels).
 * - @media : évalués si `viewport` fourni. Sans viewport : aplatis (dernier gagne).
 *   @supports/@layer/@container : toujours inclus (conditions non évaluées).
 * - Feuille UA minimale (gras titres/strong, tailles hN, italique, display).
 * - Raccourcis background/font en best-effort.
 * - Pas de layout ni pseudo-éléments calculés (::before/::after).
 */
