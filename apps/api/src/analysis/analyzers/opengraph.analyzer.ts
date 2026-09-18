import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';
import { verdictOf } from '../verdict.js';

/** Propriétés Open Graph sans lesquelles un partage n'affiche qu'une URL nue. */
const REQUIRED_OG = ['og:title', 'og:description', 'og:image', 'og:url'] as const;

export class OpenGraphAnalyzer extends BaseAnalyzer {
  readonly id = 'OPEN_GRAPH';
  readonly title = 'Open Graph & Twitter Card';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const missing: string[] = [];
    for (const property of REQUIRED_OG) {
      const content = ($(`meta[property="${property}"]`).attr('content') ?? '').trim();
      if (content) {
        items.push({
          key: `OG.${property}`,
          label: `${property} présent`,
          status: 'pass',
          value: content,
        });
      } else {
        missing.push(property);
      }
    }

    if (missing.length > 0) {
      items.push({
        key: 'OG.missing',
        label: `${missing.length} propriété(s) Open Graph manquante(s)`,
        status: 'warning',
        detail: missing.join(', '),
      });
      recommendations.push(
        `Compléter les balises Open Graph (${missing.join(', ')}) : sans elles, un partage n’affiche qu’une URL nue.`,
      );
    }

    // La Twitter Card est FACULTATIVE : son absence est signalée pour information,
    // jamais comme un défaut — la plupart des réseaux retombent sur Open Graph.
    const twitterCard = ($('meta[name="twitter:card"]').attr('content') ?? '').trim();
    items.push(
      twitterCard
        ? { key: 'OG.twitter_card', label: `Twitter Card : ${twitterCard}`, status: 'pass' }
        : {
            key: 'OG.twitter_missing',
            label: 'Twitter Card absente — Open Graph sert de repli',
            status: 'info',
          },
    );

    const verdict = verdictOf(items);
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: verdict.globalScore,
      status: verdict.status,
      items,
      summary:
        missing.length === 0
          ? 'Balises de partage complètes.'
          : `${missing.length} propriété(s) Open Graph manquante(s).`,
      recommendations,
    });
  }
}
