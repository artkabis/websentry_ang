import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { NetworkProbe } from '../network-probe.js';
import type { HtmlPage } from '../page.model.js';

/** Hôtes d'aperçu Duda : le `noindex` y est attendu, pas fautif. */
const PREVIEW_HOSTS = ['responsivesiteeditor.com', 'dudaadmin'];

export class RobotsMetaAnalyzer extends BaseAnalyzer {
  readonly id = 'ROBOTS_META';
  readonly title = 'Robots meta & robots.txt';

  async analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return this.na();

    const { $, headers } = page;
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const metaRobots = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase().trim();
    const xRobotsTag = (headers['x-robots-tag'] ?? '').toLowerCase();
    const preview = isPreviewUrl(page.url);

    this.judgeDirectives(metaRobots, xRobotsTag, preview, items, recommendations);
    await this.judgeRobotsTxt(page.url, net, items, recommendations);

    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;

    return {
      checkId: this.id,
      checkTitle: this.title,
      // Un `noindex` involontaire retire la page des moteurs : c'est le défaut
      // le plus coûteux que ce critère puisse constater, d'où le zéro.
      globalScore: failures > 0 ? 0 : warnings >= 2 ? 3 : warnings === 1 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `Meta robots : « ${metaRobots || 'non défini'} », X-Robots-Tag : « ${xRobotsTag || 'absent'} ».`,
      recommendations,
    };
  }

  private judgeDirectives(
    metaRobots: string,
    xRobotsTag: string,
    preview: boolean,
    items: CheckItem[],
    recommendations: string[],
  ): void {
    if (!metaRobots && !xRobotsTag) {
      items.push({
        key: 'ROBOTS.no_directive',
        label: 'Pas de directive robots explicite',
        status: 'pass',
        detail: 'Comportement par défaut : index, follow.',
      });
    } else {
      items.push({
        key: 'ROBOTS.directive_ok',
        label: `Robots : ${[metaRobots, xRobotsTag].filter(Boolean).join(', ')}`,
        status: 'pass',
      });
    }

    // Les directives se lisent par JETON : `nofollow` est un mot à part
    // entière, et le chercher par inclusion de chaîne ferait passer
    // `nofollow-something` — ou, plus sournois, verrait `index` dans
    // `noindex`.
    const directives = new Set([...tokenize(metaRobots), ...tokenize(xRobotsTag)]);
    const combined = [metaRobots, xRobotsTag].filter(Boolean).join(', ');

    if (directives.has('noindex')) {
      items.push(
        preview
          ? {
              key: 'ROBOTS.noindex',
              label: 'Directive noindex détectée (normal en pré-publication)',
              status: 'info',
              detail: 'Les pages de pré-publication Duda sont systématiquement en noindex.',
            }
          : {
              key: 'ROBOTS.noindex',
              label: 'Directive noindex détectée',
              status: 'fail',
              detail: combined,
            },
      );
      if (!preview) {
        recommendations.push(
          'La page est exclue de l’indexation (noindex). Si ce n’est pas intentionnel, supprimer la directive.',
        );
      }
    }

    if (directives.has('nofollow')) {
      items.push({
        key: 'ROBOTS.nofollow',
        label: 'Directive nofollow sur la page entière',
        status: 'warning',
        detail: combined,
      });
      recommendations.push(
        'La directive nofollow empêche le crawl des liens de cette page. Vérifier que c’est intentionnel.',
      );
    }

    if (directives.has('noarchive')) {
      items.push({ key: 'ROBOTS.noarchive', label: 'Directive noarchive', status: 'warning' });
    }

    if (xRobotsTag) {
      items.push({
        key: 'ROBOTS.x_robots_tag',
        label: `En-tête X-Robots-Tag : ${xRobotsTag}`,
        // Le `noindex` est déjà compté au-dessus ; le recompter ici doublerait
        // la pénalité d'un même fait déclaré à deux endroits.
        status: 'info',
      });
    }
  }

  /**
   * Présence du `robots.txt` — seule sortie réseau de ce critère.
   *
   * Sans sonde (repli sans configuration de sortie), on le DIT au lieu de
   * conclure : annoncer un robots.txt sain qu'on n'a pas vérifié serait pire
   * que ne rien annoncer.
   */
  private async judgeRobotsTxt(
    pageUrl: string,
    net: NetworkProbe | undefined,
    items: CheckItem[],
    recommendations: string[],
  ): Promise<void> {
    let robotsUrl: string;
    try {
      robotsUrl = new URL('/robots.txt', pageUrl).href;
    } catch {
      items.push({
        key: 'ROBOTS.robots_txt_error',
        label: 'Impossible de déterminer l’adresse du robots.txt',
        status: 'warning',
      });
      return;
    }

    if (!net) {
      items.push({
        key: 'ROBOTS.robots_txt_error',
        label: 'robots.txt non vérifié (sortie réseau indisponible)',
        status: 'info',
      });
      return;
    }

    const result = await net.check(robotsUrl);

    if (result.status === 200) {
      items.push({
        key: 'ROBOTS.robots_txt_ok',
        label: 'robots.txt présent',
        value: robotsUrl,
        status: 'pass',
      });
      return;
    }

    if (result.status === null) {
      items.push({
        key: 'ROBOTS.robots_txt_error',
        label: `Impossible de vérifier robots.txt — ${result.error ?? 'cause inconnue'}`,
        status: 'warning',
      });
      return;
    }

    if (result.status === 404 || result.status === 410) {
      items.push({
        key: 'ROBOTS.robots_txt_missing',
        label: `robots.txt introuvable (${result.status})`,
        status: 'warning',
      });
      recommendations.push(`Créer un fichier robots.txt à la racine du site (${robotsUrl}).`);
      return;
    }

    items.push({
      key: 'ROBOTS.robots_txt_status',
      label: `robots.txt — statut ${result.status}`,
      status: 'warning',
    });
  }
}

/** Découpe une liste de directives en jetons normalisés. */
function tokenize(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function isPreviewUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has('preview')) return true;
    return PREVIEW_HOSTS.some(host => parsed.hostname.includes(host));
  } catch {
    return false;
  }
}
