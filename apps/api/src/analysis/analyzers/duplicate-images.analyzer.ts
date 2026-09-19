import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Images répétées dans une même page.
 *
 * Toutes les répétitions ne se valent pas : un logo en en-tête ET en pied de
 * page est normal, une photo de bannière affichée trois fois trahit une section
 * dupliquée par accident. Le critère sépare donc les deux et ne pénalise que la
 * seconde.
 */

/** Profondeur d'ancêtres inspectée pour reconnaître un logo. */
const LOGO_ANCESTOR_DEPTH = 6;

interface ImageEntry {
  normalized: string;
  raw: string;
  node: Selection;
}

interface Duplicate {
  url: string;
  count: number;
}

export class DuplicateImagesAnalyzer extends BaseAnalyzer {
  readonly id = 'DUPLICATE_IMAGES';
  readonly title = 'Images en doublon';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const inline = collectImages(page);
    const backgrounds = collectBackgrounds(page);
    const unique = new Set([...inline, ...backgrounds].map(entry => entry.normalized)).size;

    if (unique === 0) return Promise.resolve(this.na('Aucune image trouvée sur la page.'));

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const fromImages = classify(inline);
    const fromBackgrounds = classify(backgrounds);
    const logos = [...fromImages.logos, ...fromBackgrounds.logos];
    const accidental = [...fromImages.accidental, ...fromBackgrounds.accidental];

    items.push({
      key: 'DUP.unique_count',
      label: `${unique} image(s) unique(s) détectée(s)`,
      status: 'pass',
    });

    if (logos.length > 0) {
      items.push({
        key: 'DUP.logos',
        label: `${logos.length} logo(s) présent(s) plusieurs fois (en-tête / pied de page — normal)`,
        status: 'info',
        detail: describe(logos),
      });
    }

    if (accidental.length === 0) {
      items.push({
        key: 'DUP.no_duplicates',
        label: 'Aucune image en doublon (hors logos)',
        status: 'pass',
      });
    } else {
      items.push({
        key: 'DUP.duplicates',
        label: `${accidental.length} image(s) en doublon (hors logos)`,
        status: 'warning',
        detail: describe(accidental),
      });
      recommendations.push(
        `${accidental.length} image(s) apparaissent plusieurs fois sans être des logos : vérifier qu'une section n'a pas été dupliquée par erreur.`,
      );
    }

    const duplicated = accidental.length > 0;
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: duplicated ? 3 : 5,
      status: duplicated ? 'warning' : 'pass',
      items,
      summary: duplicated
        ? `${accidental.length} image(s) en doublon (hors logos) sur ${unique} image(s) unique(s).`
        : logos.length > 0
          ? `${logos.length} logo(s) répété(s) — aucun doublon problématique sur ${unique} image(s).`
          : `Aucun doublon détecté sur ${unique} image(s).`,
      recommendations,
    });
  }
}

function collectImages(page: HtmlPage): ImageEntry[] {
  const { $ } = page;
  const entries: ImageEntry[] = [];

  $('img[src]').each((_, element) => {
    const raw = $(element).attr('src') ?? '';
    const normalized = normalize(raw, page.url);
    if (normalized) entries.push({ normalized, raw, node: $(element) });
  });

  return entries;
}

function collectBackgrounds(page: HtmlPage): ImageEntry[] {
  const { $ } = page;
  const entries: ImageEntry[] = [];

  $('[style]').each((_, element) => {
    const raw = backgroundUrl($(element).attr('style') ?? '');
    if (!raw) return;
    const normalized = normalize(raw, page.url);
    if (normalized) entries.push({ normalized, raw, node: $(element) });
  });

  return entries;
}

/** Deux URL ne désignent pas deux images parce qu'elles portent un `?v=2`. */
function normalize(src: string, pageUrl: string): string {
  if (src.startsWith('data:')) return '';
  try {
    const absolute = new URL(src, pageUrl);
    absolute.search = '';
    absolute.hash = '';
    return absolute.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return src.trim().toLowerCase().replace(/\?.*$/, '').replace(/#.*$/, '');
  }
}

function backgroundUrl(style: string): string | null {
  const match = /background(?:-image)?\s*:[^;]*url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(style);
  return match?.[1] ?? null;
}

function classify(entries: ImageEntry[]): { logos: Duplicate[]; accidental: Duplicate[] } {
  const byUrl = new Map<string, ImageEntry[]>();
  for (const entry of entries) {
    const group = byUrl.get(entry.normalized) ?? [];
    group.push(entry);
    byUrl.set(entry.normalized, group);
  }

  const logos: Duplicate[] = [];
  const accidental: Duplicate[] = [];

  for (const [url, group] of byUrl) {
    if (group.length <= 1) continue;
    // UNE occurrence reconnue comme logo suffit : c'est la même image, et
    // c'est bien le logo qui se répète.
    const isLogo = group.some(entry => looksLikeLogo(entry));
    (isLogo ? logos : accidental).push({ url, count: group.length });
  }

  return { logos, accidental };
}

/**
 * L'image est-elle un logo ?
 *
 * Reconnu par son `alt`, son URL, sa classe, son identifiant, ceux de ses
 * ancêtres, ou sa seule présence dans un `<header>` — où un éditeur en ligne
 * place le logo sans jamais le nommer.
 */
function looksLikeLogo(entry: ImageEntry): boolean {
  const { node, raw } = entry;
  if (raw.toLowerCase().includes('logo')) return true;

  for (const attribute of ['alt', 'class', 'id']) {
    if ((node.attr(attribute) ?? '').toLowerCase().includes('logo')) return true;
  }

  let parent = node.parent();
  for (let depth = 0; depth < LOGO_ANCESTOR_DEPTH && parent.length > 0; depth += 1) {
    const classes = (parent.attr('class') ?? '').toLowerCase();
    const id = (parent.attr('id') ?? '').toLowerCase();
    if (classes.includes('logo') || id.includes('logo')) return true;
    if (String(parent.prop('tagName') ?? '').toLowerCase() === 'header') return true;
    parent = parent.parent();
  }

  return false;
}

function describe(duplicates: readonly Duplicate[]): string {
  return duplicates.map(entry => `×${entry.count} — ${shortLabel(entry.url)}`).join('\n');
}

function shortLabel(url: string): string {
  const name = url.split('/').pop() || url;
  return name.length > 60 ? `…${name.slice(-57)}` : name;
}
