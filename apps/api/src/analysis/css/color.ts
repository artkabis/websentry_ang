/**
 * color.ts — Parsing couleur CSS + WCAG, zéro dépendance.
 *
 * Méthodologie inspirée de culori : chaque syntaxe CSS est convertie vers un
 * espace intermédiaire (sRGB linéaire ou XYZ) puis rendue en sRGB 8 bits.
 * Couvre : couleurs nommées (set CSS complet), hex 3/4/6/8, rgb()/rgba()
 * (legacy + syntaxe moderne espaces + `none`), hsl()/hsla(), hwb(),
 * lab(), lch(), oklab(), oklch(), color(<space> …) et color-mix().
 *
 * Sortie unique : { r, g, b, a } avec r,g,b ∈ [0,255] et a ∈ [0,1].
 * Objectif : analyse de contraste fiable, pas de fidélité gamut absolue.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Couleurs nommées CSS (Color Module Level 4) + transparent
// ─────────────────────────────────────────────────────────────────────────────

const NAMED: Record<string, [number, number, number, number]> = {
  transparent: [0, 0, 0, 0],
  aliceblue: [240, 248, 255, 1],
  antiquewhite: [250, 235, 215, 1],
  aqua: [0, 255, 255, 1],
  aquamarine: [127, 255, 212, 1],
  azure: [240, 255, 255, 1],
  beige: [245, 245, 220, 1],
  bisque: [255, 228, 196, 1],
  black: [0, 0, 0, 1],
  blanchedalmond: [255, 235, 205, 1],
  blue: [0, 0, 255, 1],
  blueviolet: [138, 43, 226, 1],
  brown: [165, 42, 42, 1],
  burlywood: [222, 184, 135, 1],
  cadetblue: [95, 158, 160, 1],
  chartreuse: [127, 255, 0, 1],
  chocolate: [210, 105, 30, 1],
  coral: [255, 127, 80, 1],
  cornflowerblue: [100, 149, 237, 1],
  cornsilk: [255, 248, 220, 1],
  crimson: [220, 20, 60, 1],
  cyan: [0, 255, 255, 1],
  darkblue: [0, 0, 139, 1],
  darkcyan: [0, 139, 139, 1],
  darkgoldenrod: [184, 134, 11, 1],
  darkgray: [169, 169, 169, 1],
  darkgreen: [0, 100, 0, 1],
  darkgrey: [169, 169, 169, 1],
  darkkhaki: [189, 183, 107, 1],
  darkmagenta: [139, 0, 139, 1],
  darkolivegreen: [85, 107, 47, 1],
  darkorange: [255, 140, 0, 1],
  darkorchid: [153, 50, 204, 1],
  darkred: [139, 0, 0, 1],
  darksalmon: [233, 150, 122, 1],
  darkseagreen: [143, 188, 143, 1],
  darkslateblue: [72, 61, 139, 1],
  darkslategray: [47, 79, 79, 1],
  darkslategrey: [47, 79, 79, 1],
  darkturquoise: [0, 206, 209, 1],
  darkviolet: [148, 0, 211, 1],
  deeppink: [255, 20, 147, 1],
  deepskyblue: [0, 191, 255, 1],
  dimgray: [105, 105, 105, 1],
  dimgrey: [105, 105, 105, 1],
  dodgerblue: [30, 144, 255, 1],
  firebrick: [178, 34, 34, 1],
  floralwhite: [255, 250, 240, 1],
  forestgreen: [34, 139, 34, 1],
  fuchsia: [255, 0, 255, 1],
  gainsboro: [220, 220, 220, 1],
  ghostwhite: [248, 248, 255, 1],
  gold: [255, 215, 0, 1],
  goldenrod: [218, 165, 32, 1],
  gray: [128, 128, 128, 1],
  green: [0, 128, 0, 1],
  greenyellow: [173, 255, 47, 1],
  grey: [128, 128, 128, 1],
  honeydew: [240, 255, 240, 1],
  hotpink: [255, 105, 180, 1],
  indianred: [205, 92, 92, 1],
  indigo: [75, 0, 130, 1],
  ivory: [255, 255, 240, 1],
  khaki: [240, 230, 140, 1],
  lavender: [230, 230, 250, 1],
  lavenderblush: [255, 240, 245, 1],
  lawngreen: [124, 252, 0, 1],
  lemonchiffon: [255, 250, 205, 1],
  lightblue: [173, 216, 230, 1],
  lightcoral: [240, 128, 128, 1],
  lightcyan: [224, 255, 255, 1],
  lightgoldenrodyellow: [250, 250, 210, 1],
  lightgray: [211, 211, 211, 1],
  lightgreen: [144, 238, 144, 1],
  lightgrey: [211, 211, 211, 1],
  lightpink: [255, 182, 193, 1],
  lightsalmon: [255, 160, 122, 1],
  lightseagreen: [32, 178, 170, 1],
  lightskyblue: [135, 206, 250, 1],
  lightslategray: [119, 136, 153, 1],
  lightslategrey: [119, 136, 153, 1],
  lightsteelblue: [176, 196, 222, 1],
  lightyellow: [255, 255, 224, 1],
  lime: [0, 255, 0, 1],
  limegreen: [50, 205, 50, 1],
  linen: [250, 240, 230, 1],
  magenta: [255, 0, 255, 1],
  maroon: [128, 0, 0, 1],
  mediumaquamarine: [102, 205, 170, 1],
  mediumblue: [0, 0, 205, 1],
  mediumorchid: [186, 85, 211, 1],
  mediumpurple: [147, 112, 219, 1],
  mediumseagreen: [60, 179, 113, 1],
  mediumslateblue: [123, 104, 238, 1],
  mediumspringgreen: [0, 250, 154, 1],
  mediumturquoise: [72, 209, 204, 1],
  mediumvioletred: [199, 21, 133, 1],
  midnightblue: [25, 25, 112, 1],
  mintcream: [245, 255, 250, 1],
  mistyrose: [255, 228, 225, 1],
  moccasin: [255, 228, 181, 1],
  navajowhite: [255, 222, 173, 1],
  navy: [0, 0, 128, 1],
  oldlace: [253, 245, 230, 1],
  olive: [128, 128, 0, 1],
  olivedrab: [107, 142, 35, 1],
  orange: [255, 165, 0, 1],
  orangered: [255, 69, 0, 1],
  orchid: [218, 112, 214, 1],
  palegoldenrod: [238, 232, 170, 1],
  palegreen: [152, 251, 152, 1],
  paleturquoise: [175, 238, 238, 1],
  palevioletred: [219, 112, 147, 1],
  papayawhip: [255, 239, 213, 1],
  peachpuff: [255, 218, 185, 1],
  peru: [205, 133, 63, 1],
  pink: [255, 192, 203, 1],
  plum: [221, 160, 221, 1],
  powderblue: [176, 224, 230, 1],
  purple: [128, 0, 128, 1],
  rebeccapurple: [102, 51, 153, 1],
  red: [255, 0, 0, 1],
  rosybrown: [188, 143, 143, 1],
  royalblue: [65, 105, 225, 1],
  saddlebrown: [139, 69, 19, 1],
  salmon: [250, 128, 114, 1],
  sandybrown: [244, 164, 96, 1],
  seagreen: [46, 139, 87, 1],
  seashell: [255, 245, 238, 1],
  sienna: [160, 82, 45, 1],
  silver: [192, 192, 192, 1],
  skyblue: [135, 206, 235, 1],
  slateblue: [106, 90, 205, 1],
  slategray: [112, 128, 144, 1],
  slategrey: [112, 128, 144, 1],
  snow: [255, 250, 250, 1],
  springgreen: [0, 255, 127, 1],
  steelblue: [70, 130, 180, 1],
  tan: [210, 180, 140, 1],
  teal: [0, 128, 128, 1],
  thistle: [216, 191, 216, 1],
  tomato: [255, 99, 71, 1],
  turquoise: [64, 224, 208, 1],
  violet: [238, 130, 238, 1],
  wheat: [245, 222, 179, 1],
  white: [255, 255, 255, 1],
  whitesmoke: [245, 245, 245, 1],
  yellow: [255, 255, 0, 1],
  yellowgreen: [154, 205, 50, 1],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers numériques
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp255 = (v: number): number => clamp(Math.round(v), 0, 255);

/** Transfert sRGB linéaire → gamma (composante ∈ [0,1], peut déborder). */
function gamma(c: number): number {
  const abs = Math.abs(c);
  const sign = c < 0 ? -1 : 1;
  return abs <= 0.0031308 ? 12.92 * c : sign * (1.055 * abs ** (1 / 2.4) - 0.055);
}

/** Transfert sRGB gamma → linéaire. */
function linearize(c: number): number {
  const abs = Math.abs(c);
  const sign = c < 0 ? -1 : 1;
  return abs <= 0.04045 ? c / 12.92 : sign * ((abs + 0.055) / 1.055) ** 2.4;
}

function mul(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// Matrices CSS Color 4
const _LIN_SRGB_TO_XYZ: Mat3 = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_LIN_SRGB: Mat3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const LIN_P3_TO_XYZ: Mat3 = [
  [0.4865709486482162, 0.26566769316909306, 0.19821728523436247],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0.0, 0.04511338185890264, 1.043944368900976],
];
const LIN_REC2020_TO_XYZ: Mat3 = [
  [0.6369580483012914, 0.14461690358620832, 0.16888097516417205],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0.0, 0.028072693049087428, 1.060985057710791],
];
const LIN_A98_TO_XYZ: Mat3 = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];
const LIN_PROPHOTO_TO_XYZ_D50: Mat3 = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0.0, 0.0, 0.8251046025104601],
];
const _D65_TO_D50: Mat3 = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];
const D50_TO_D65: Mat3 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const WHITE_D50: [number, number, number] = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

/**
 * Vecteur et matrice à taille FIXE.
 *
 * Les types portent la dimension : l'indexation y est totale, et aucune garde
 * d'exécution n'est nécessaire pour un produit matriciel dont les bornes sont
 * connues à la compilation.
 */
type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

// ─────────────────────────────────────────────────────────────────────────────
// Conversions espace → sRGB (0..1, non bornées)
// ─────────────────────────────────────────────────────────────────────────────

function xyzD65ToSrgb(xyz: [number, number, number]): [number, number, number] {
  return mul(XYZ_TO_LIN_SRGB, xyz).map(gamma) as [number, number, number];
}

function hueToRgb(h: number): [number, number, number] {
  // h en degrés → sRGB pur (S=100%, L=50%)
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((hp % 2) - 1);
  let rgb: [number, number, number];
  if (hp < 1) rgb = [1, x, 0];
  else if (hp < 2) rgb = [x, 1, 0];
  else if (hp < 3) rgb = [0, 1, x];
  else if (hp < 4) rgb = [0, x, 1];
  else if (hp < 5) rgb = [x, 0, 1];
  else rgb = [1, 0, x];
  return rgb;
}

function hslToSrgb(h: number, s: number, l: number): [number, number, number] {
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  const [r, g, b] = hueToRgb(h); // teinte pure normalisée (max = 1)
  const c = (1 - Math.abs(2 * l - 1)) * s; // chroma
  const m = l - c / 2;
  return [r * c + m, g * c + m, b * c + m].map(v => clamp(v, 0, 1)) as [number, number, number];
}

function hwbToSrgb(h: number, w: number, bl: number): [number, number, number] {
  w = clamp(w, 0, 1);
  bl = clamp(bl, 0, 1);
  if (w + bl >= 1) {
    const gray = w / (w + bl);
    return [gray, gray, gray];
  }
  const base = hueToRgb(h);
  return base.map(c => c * (1 - w - bl) + w) as [number, number, number];
}

function labToXyzD50(L: number, a: number, b: number): [number, number, number] {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  return [xr * WHITE_D50[0], yr * WHITE_D50[1], zr * WHITE_D50[2]];
}

function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const xyzD50 = labToXyzD50(L, a, b);
  const xyzD65 = mul(D50_TO_D65, xyzD50);
  return xyzD65ToSrgb(xyzD65);
}

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin: [number, number, number] = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map(gamma) as [number, number, number];
}

const polarToRect = (Lc: number, h: number): [number, number] => [
  Lc * Math.cos((h * Math.PI) / 180),
  Lc * Math.sin((h * Math.PI) / 180),
];

// ─────────────────────────────────────────────────────────────────────────────
// Parsing des composantes d'une fonction
// ─────────────────────────────────────────────────────────────────────────────

/** Découpe l'intérieur d'une fonction en arguments (espaces, virgules, slash alpha). */
function tokenizeComponents(inner: string): { comps: string[]; alpha: string | null } {
  // Sépare d'abord l'alpha derrière un '/' de haut niveau
  let depth = 0;
  let slashIdx = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '/' && depth === 0) {
      slashIdx = i;
      break;
    }
  }
  const head = slashIdx >= 0 ? inner.slice(0, slashIdx) : inner;
  const alpha = slashIdx >= 0 ? inner.slice(slashIdx + 1).trim() : null;

  const comps: string[] = [];
  let buf = '';
  depth = 0;
  for (const ch of head.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if ((ch === ',' || /\s/.test(ch)) && depth === 0) {
      if (buf) {
        comps.push(buf);
        buf = '';
      }
    } else buf += ch;
  }
  if (buf) comps.push(buf);
  return { comps, alpha };
}

/** Nombre brut (none→0), `%` rapporté à `scale`, sinon valeur directe. */
function num(token: string | undefined, scale = 1): number {
  if (token == null || token === 'none') return 0;
  const t = token.trim();
  if (t.endsWith('%')) return (Number.parseFloat(t) / 100) * scale;
  return Number.parseFloat(t);
}

/** Angle de teinte : deg/grad/rad/turn → degrés. */
function hue(token: string | undefined): number {
  if (token == null || token === 'none') return 0;
  const t = token.trim().toLowerCase();
  const v = Number.parseFloat(t);
  if (t.endsWith('grad')) return v * 0.9;
  if (t.endsWith('rad')) return (v * 180) / Math.PI;
  if (t.endsWith('turn')) return v * 360;
  return v;
}

function alphaOf(token: string | null): number {
  if (token == null || token === 'none') return token === 'none' ? 0 : 1;
  const t = token.trim();
  const v = t.endsWith('%') ? Number.parseFloat(t) / 100 : Number.parseFloat(t);
  return Number.isNaN(v) ? 1 : clamp(v, 0, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// color(<space> …)
// ─────────────────────────────────────────────────────────────────────────────

function parseColorFunction(comps: string[], a: number): Rgba | null {
  const space = (comps.shift() ?? '').toLowerCase();
  const c = comps.map(t => num(t, 1));
  const [c0 = 0, c1 = 0, c2 = 0] = c;
  let srgb: [number, number, number];

  switch (space) {
    case 'srgb':
      srgb = [c0, c1, c2];
      break;
    case 'srgb-linear':
      srgb = [c0, c1, c2].map(gamma) as [number, number, number];
      break;
    case 'display-p3':
      srgb = xyzD65ToSrgb(
        mul(LIN_P3_TO_XYZ, [c0, c1, c2].map(linearize) as [number, number, number]),
      );
      break;
    case 'rec2020':
      srgb = xyzD65ToSrgb(
        mul(LIN_REC2020_TO_XYZ, [c0, c1, c2].map(linearize) as [number, number, number]),
      );
      break;
    case 'a98-rgb':
      srgb = xyzD65ToSrgb(
        mul(
          LIN_A98_TO_XYZ,
          [c0, c1, c2].map(v => (v < 0 ? -1 : 1) * Math.abs(v) ** (563 / 256)) as [
            number,
            number,
            number,
          ],
        ),
      );
      break;
    case 'prophoto-rgb': {
      const linP = [c0, c1, c2].map(v => {
        const abs = Math.abs(v);
        return abs <= 16 / 512 ? v / 16 : (v < 0 ? -1 : 1) * abs ** 1.8;
      }) as [number, number, number];
      srgb = xyzD65ToSrgb(mul(D50_TO_D65, mul(LIN_PROPHOTO_TO_XYZ_D50, linP)));
      break;
    }
    case 'xyz':
    case 'xyz-d65':
      srgb = xyzD65ToSrgb([c0, c1, c2]);
      break;
    case 'xyz-d50':
      srgb = xyzD65ToSrgb(mul(D50_TO_D65, [c0, c1, c2]));
      break;
    default:
      return null;
  }
  return { r: clamp255(srgb[0] * 255), g: clamp255(srgb[1] * 255), b: clamp255(srgb[2] * 255), a };
}

// ─────────────────────────────────────────────────────────────────────────────
// color-mix(in <space>, c1 [p1], c2 [p2])
// ─────────────────────────────────────────────────────────────────────────────

const _POLAR_SPACES = new Set(['hsl', 'hwb', 'lch', 'oklch']);

function toMixCoords(space: string, c: Rgba): [number, number, number] {
  // Représentation de travail par espace (avant interpolation)
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255;
  switch (space) {
    case 'srgb':
      return [r, g, b];
    case 'srgb-linear':
      return [linearize(r), linearize(g), linearize(b)];
    default: {
      // oklab/oklch/lab/lch/hsl/hwb : on passe par linéaire→oklab pour un mélange perceptuel correct
      const ll = [linearize(r), linearize(g), linearize(b)] as [number, number, number];
      const l = Math.cbrt(0.4122214708 * ll[0] + 0.5363325363 * ll[1] + 0.0514459929 * ll[2]);
      const m = Math.cbrt(0.2119034982 * ll[0] + 0.6806995451 * ll[1] + 0.1073969566 * ll[2]);
      const s = Math.cbrt(0.0883024619 * ll[0] + 0.2817188376 * ll[1] + 0.6299787005 * ll[2]);
      const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
      const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
      const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      return [L, A, B];
    }
  }
}

function fromMixCoords(space: string, v: [number, number, number], a: number): Rgba {
  let srgb: [number, number, number];
  if (space === 'srgb') srgb = v;
  else if (space === 'srgb-linear') srgb = v.map(gamma) as [number, number, number];
  else srgb = oklabToSrgb(v[0], v[1], v[2]);
  return { r: clamp255(srgb[0] * 255), g: clamp255(srgb[1] * 255), b: clamp255(srgb[2] * 255), a };
}

function parseColorMix(inner: string): Rgba | null {
  // « in <space>[ <hue-method>], c1 [p%], c2 [p%] »
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  if (parts.length < 3) return null;

  const inClause = (parts[0] ?? '')
    .toLowerCase()
    .replace(/^in\s+/, '')
    .trim();
  let space = inClause.split(/\s+/)[0] ?? '';
  if (!['srgb', 'srgb-linear', 'oklab', 'oklch', 'lab', 'lch', 'hsl', 'hwb'].includes(space)) {
    space = 'oklab';
  }
  // espaces polaires → mélange perceptuel oklab (approx suffisante pour le contraste)
  const workSpace = space === 'srgb' || space === 'srgb-linear' ? space : 'oklab';

  const splitColorPct = (s: string): { color: string; pct: number | null } => {
    const m = s.match(/\s(\d*\.?\d+)%\s*$/);
    if (m?.[1]) return { color: s.slice(0, m.index).trim(), pct: Number.parseFloat(m[1]) };
    return { color: s, pct: null };
  };

  const a1 = splitColorPct(parts[1] ?? '');
  const a2 = splitColorPct(parts[2] ?? '');
  const col1 = parseColor(a1.color);
  const col2 = parseColor(a2.color);
  if (!col1 || !col2) return null;

  let p1 = a1.pct;
  let p2 = a2.pct;
  if (p1 == null && p2 == null) {
    p1 = 50;
    p2 = 50;
  } else if (p1 == null) p1 = 100 - (p2 as number);
  else if (p2 == null) p2 = 100 - p1;
  const sum = p1 + (p2 as number) || 100;
  const w1 = p1 / sum;
  const w2 = (p2 as number) / sum;

  const v1 = toMixCoords(workSpace, col1);
  const v2 = toMixCoords(workSpace, col2);
  const mixed: [number, number, number] = [
    v1[0] * w1 + v2[0] * w2,
    v1[1] * w1 + v2[1] * w2,
    v1[2] * w1 + v2[2] * w2,
  ];
  const alpha = col1.a * w1 + col2.a * w2;
  return fromMixCoords(workSpace, mixed, clamp(alpha, 0, 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée : parseColor
// ─────────────────────────────────────────────────────────────────────────────

export function parseColor(input: string | null | undefined): Rgba | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const str = raw.toLowerCase();

  // Couleurs nommées + transparent
  const named = Object.prototype.hasOwnProperty.call(NAMED, str) ? NAMED[str] : undefined;
  if (named) {
    const [r, g, b, a] = named;
    return { r, g, b, a };
  }

  // Hex
  if (str[0] === '#') {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4)
      hex = hex
        .split('')
        .map(c => c + c)
        .join('');
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
      if ([...hex].every(c => /[0-9a-f]/.test(c))) {
        return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
      }
    }
    return null;
  }

  // Fonctions
  const fn = str.match(/^([a-z-]+)\((.*)\)$/s);
  if (!fn) return null;
  const name = fn[1] ?? '';
  const inner = fn[2] ?? '';

  if (name === 'color-mix') return parseColorMix(inner);

  const { comps, alpha } = tokenizeComponents(inner);
  const a = alphaOf(alpha);
  /** Composante par rang — une composante absente vaut la chaîne vide, que les
   * convertisseurs traitent déjà comme zéro. */
  const comp = (index: number): string => comps[index] ?? '';

  switch (name) {
    case 'rgb':
    case 'rgba': {
      // legacy: 0..255 ou %; moderne accepte aussi `none`
      const conv = (t: string): number =>
        t.trim().endsWith('%') ? clamp255(num(t, 255)) : clamp255(num(t, 1));
      // alpha legacy peut être en 4e composante
      const aFinal = alpha != null ? a : comps.length >= 4 ? alphaOf(comp(3)) : 1;
      return { r: conv(comp(0)), g: conv(comp(1)), b: conv(comp(2)), a: aFinal };
    }
    case 'hsl':
    case 'hsla': {
      const aFinal = alpha != null ? a : comps.length >= 4 ? alphaOf(comp(3)) : 1;
      const srgb = hslToSrgb(hue(comp(0)), num(comp(1), 1), num(comp(2), 1));
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a: aFinal,
      };
    }
    case 'hwb': {
      const srgb = hwbToSrgb(hue(comp(0)), num(comp(1), 1), num(comp(2), 1));
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a,
      };
    }
    case 'lab': {
      const srgb = labToSrgb(num(comp(0), 100), num(comp(1), 125), num(comp(2), 125));
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a,
      };
    }
    case 'lch': {
      const [aa, bb] = polarToRect(num(comp(1), 150), hue(comp(2)));
      const srgb = labToSrgb(num(comp(0), 100), aa, bb);
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a,
      };
    }
    case 'oklab': {
      const srgb = oklabToSrgb(num(comp(0), 1), num(comp(1), 0.4), num(comp(2), 0.4));
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a,
      };
    }
    case 'oklch': {
      const [aa, bb] = polarToRect(num(comp(1), 0.4), hue(comp(2)));
      const srgb = oklabToSrgb(num(comp(0), 1), aa, bb);
      return {
        r: clamp255(srgb[0] * 255),
        g: clamp255(srgb[1] * 255),
        b: clamp255(srgb[2] * 255),
        a,
      };
    }
    case 'color':
      return parseColorFunction(comps, a);
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition alpha + WCAG
// ─────────────────────────────────────────────────────────────────────────────

export function isTransparent(c: Rgba | null): boolean {
  return !c || c.a <= 0;
}

/** Composite `src` (premier plan) sur `dst` (arrière-plan) — alpha "source-over". */
export function blendOver(src: Rgba, dst: Rgba): Rgba {
  const a = src.a + dst.a * (1 - src.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (src.r * src.a + dst.r * dst.a * (1 - src.a)) / a,
    g: (src.g * src.a + dst.g * dst.a * (1 - src.a)) / a,
    b: (src.b * src.a + dst.b * dst.a * (1 - src.a)) / a,
    a,
  };
}

/** Luminance relative WCAG 2.x (sRGB). */
export function relativeLuminance(c: Rgba): number {
  const lin = (ch: number): number => linearize(ch / 255);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Ratio de contraste WCAG 2.x ∈ [1, 21]. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
