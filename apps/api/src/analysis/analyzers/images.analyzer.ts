import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import { truncateSource } from '../locate.js';
import type { NetworkProbe, ProbeResult } from '../network-probe.js';
import type { HtmlPage } from '../page.model.js';

/** Formats compressés modernes — ceux qu'on recommande. */
const MODERN_FORMATS: ReadonlySet<string> = new Set(['webp', 'avif', 'svg']);
/** Formats hérités : lisibles partout, mais nettement plus lourds. */
const LEGACY_FORMATS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff']);

/**
 * Plafond d'images pesées pour UNE page.
 *
 * Au-delà, on mesure un échantillon plutôt que d'émettre des milliers de
 * requêtes vers le site audité — et le rapport le DIT, pour qu'un « poids
 * correct » ne soit pas lu comme une garantie sur l'ensemble.
 */
const MAX_WEIGHED = 200;

interface PageImage {
  raw: string;
  absolute: string;
  alt: string | undefined;
  source: string | undefined;
}

export class ImagesAnalyzer extends BaseAnalyzer {
  readonly id = 'IMAGES';
  readonly title = 'Images (alt, poids, format)';

  async analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return this.na();

    const images = collect(page);
    if (images.length === 0) return this.na('Aucune image trouvée sur la page.');

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    this.judgeAlt(images, items, recommendations);
    const weighed = await this.judgeWeight(images, settings, net, items, recommendations);
    this.judgeFormats(images, weighed, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore:
        failures >= 2 ? 0 : failures === 1 ? 2 : warnings > 1 ? 3 : warnings === 1 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${images.length} image(s) analysée(s) — ${failures} erreur(s), ${warnings} avertissement(s).`,
      recommendations,
    };
  }

  private judgeAlt(images: PageImage[], items: CheckItem[], recommendations: string[]): void {
    const missing = images.filter(image => image.alt === undefined);
    const decorative = images.filter(image => image.alt === '').length;

    if (missing.length > 0) {
      items.push({
        key: 'IMAGES.alt_missing',
        label: `${missing.length} image(s) sans attribut alt`,
        status: 'fail',
        detail: missing.map(image => fileName(image.absolute)).join(', '),
        // Une image n'a pas de texte à cibler : on montre son code source.
        source: missing[0]?.source,
      });
      recommendations.push(
        `Ajouter l'attribut alt à ${missing.length} image(s) : décrire le contenu, ou alt="" si l'image est décorative.`,
      );
    } else {
      items.push({
        key: 'IMAGES.alt_present',
        label: `Alt présent sur les ${images.length} image(s)`,
        status: 'pass',
      });
    }

    if (decorative > 0) {
      items.push({
        key: 'IMAGES.decorative',
        label: `${decorative} image(s) décorative(s) (alt="")`,
        status: 'pass',
      });
    }
  }

  /**
   * Pèse les images par requête HEAD.
   *
   * Sans sonde réseau, aucun poids n'est mesuré — et le rapport le dit plutôt
   * que d'annoncer « poids correct », ce qui serait une affirmation sans
   * mesure.
   */
  private async judgeWeight(
    images: PageImage[],
    settings: EffectiveSettings,
    net: NetworkProbe | undefined,
    items: CheckItem[],
    recommendations: string[],
  ): Promise<Map<string, ProbeResult>> {
    const weighed = new Map<string, ProbeResult>();
    if (!net) {
      items.push({
        label: 'Poids des images non mesuré (sortie réseau indisponible)',
        status: 'info',
      });
      return weighed;
    }

    const urls = [...new Set(images.map(image => image.absolute))];
    const measured = urls.slice(0, MAX_WEIGHED);
    const results = await net.checkMany(measured);
    for (const result of results) weighed.set(result.url, result);

    const { maxSizeBytes, warningThresholdBytes } = settings.images;
    const heavy: string[] = [];
    const borderline: string[] = [];

    for (const result of results) {
      const size = result.contentLength;
      if (size === null) continue;
      const label = `${fileName(result.url)} (${Math.round(size / 1024)} Ko)`;
      if (size > maxSizeBytes) heavy.push(label);
      else if (size > warningThresholdBytes) borderline.push(label);
    }

    if (heavy.length > 0) {
      items.push({
        key: 'IMAGES.weight_fail',
        label: `${heavy.length} image(s) trop lourde(s) (> ${Math.round(maxSizeBytes / 1024)} Ko)`,
        status: 'fail',
        detail: heavy.join(', '),
      });
      recommendations.push(
        `Optimiser ${heavy.length} image(s) dépassant ${Math.round(maxSizeBytes / 1024)} Ko : compression, conversion en WebP, redimensionnement.`,
      );
    }

    if (borderline.length > 0) {
      items.push({
        key: 'IMAGES.weight_warn',
        label: `${borderline.length} image(s) lourde(s) (> ${Math.round(warningThresholdBytes / 1024)} Ko)`,
        status: 'warning',
        detail: borderline.join(', '),
      });
      recommendations.push(
        `${borderline.length} image(s) approchent le plafond de poids : envisager leur optimisation.`,
      );
    }

    if (heavy.length === 0 && borderline.length === 0) {
      items.push({ key: 'IMAGES.weight_ok', label: 'Poids des images correct', status: 'pass' });
    }

    const notMeasured = urls.length - measured.length;
    if (notMeasured > 0) {
      items.push({
        label: `Poids non mesuré pour ${notMeasured} image(s) — plafond de ${MAX_WEIGHED} par page`,
        status: 'info',
      });
    }

    return weighed;
  }

  /**
   * Le format se lit d'abord dans le TYPE MIME, puis dans l'extension.
   *
   * Beaucoup de CDN servent des URL sans extension : s'en tenir à l'URL, comme
   * le faisait la v1, laissait ces images hors du contrôle — précisément les
   * images d'un site construit avec un éditeur en ligne.
   */
  private judgeFormats(
    images: PageImage[],
    weighed: Map<string, ProbeResult>,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const legacy = images.filter(image => {
      const format = formatOf(image, weighed.get(image.absolute));
      return format !== null && LEGACY_FORMATS.has(format) && !MODERN_FORMATS.has(format);
    });

    if (legacy.length === 0) return;

    const formats = [
      ...new Set(legacy.map(image => formatOf(image, weighed.get(image.absolute)) ?? '')),
    ].filter(Boolean);

    items.push({
      key: 'IMAGES.format_modern',
      label: `${legacy.length} image(s) dans un format non moderne`,
      status: 'warning',
      detail: `Préférer WebP ou AVIF (${formats.join(', ')})`,
      source: legacy[0]?.source,
    });
    recommendations.push(
      'Convertir les images en WebP ou AVIF : à qualité égale, elles pèsent nettement moins lourd.',
    );
  }
}

function collect(page: HtmlPage): PageImage[] {
  const { $ } = page;
  const images: PageImage[] = [];

  $('img').each((_, element) => {
    const node = $(element);
    const raw = node.attr('src') ?? '';
    // Une image en ligne (`data:`) n'a ni URL à peser ni format à convertir.
    if (!raw || raw.startsWith('data:')) return;

    images.push({
      raw,
      absolute: toAbsolute(raw, page.url),
      alt: node.attr('alt'),
      source: truncateSource($.html(element)),
    });
  });

  return images;
}

function toAbsolute(src: string, pageUrl: string): string {
  try {
    return new URL(src, pageUrl).href;
  } catch {
    return src;
  }
}

function formatOf(image: PageImage, probe: ProbeResult | undefined): string | null {
  const mime = probe?.contentType?.split(';')[0]?.trim().toLowerCase();
  if (mime?.startsWith('image/')) {
    const subtype = mime.slice('image/'.length);
    return subtype === 'jpeg' ? 'jpeg' : subtype === 'svg+xml' ? 'svg' : subtype;
  }

  const path = image.absolute.split('?')[0] ?? '';
  const extension = path.includes('.') ? (path.split('.').pop() ?? '') : '';
  return extension.toLowerCase() || null;
}

function fileName(url: string): string {
  const path = url.split('?')[0] ?? url;
  return path.split('/').pop() || url;
}
