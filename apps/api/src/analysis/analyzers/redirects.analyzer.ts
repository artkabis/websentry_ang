import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';
import { verdictOf } from '../verdict.js';

/** Au-delà, la chaîne coûte plus en latence qu'elle ne rend de service. */
const MAX_COMFORTABLE_HOPS = 1;

export class RedirectsAnalyzer extends BaseAnalyzer {
  readonly id = 'REDIRECTS';
  readonly title = 'Redirections HTTP';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const chain = page.redirectChain;
    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    if (chain.length === 0) {
      return Promise.resolve(
        this.pass(
          [{ key: 'REDIRECTS.none', label: 'Accès direct, sans redirection', status: 'pass' }],
          'La page répond directement.',
        ),
      );
    }

    for (const hop of chain) {
      items.push({
        key: 'REDIRECTS.hop',
        label: `${hop.status} → ${hop.url}`,
        status: 'info',
      });
    }

    if (chain.length > MAX_COMFORTABLE_HOPS) {
      items.push({
        key: 'REDIRECTS.chain_long',
        label: `Chaîne de ${chain.length} redirections`,
        status: 'warning',
        detail: chain.map(hop => `${hop.status} ${hop.url}`).join(' → '),
      });
      recommendations.push(
        `Réduire la chaîne à une seule redirection : ${chain.length} sauts ajoutent autant d’allers-retours avant le premier octet.`,
      );
    }

    // Une 302 dit « temporaire » : le moteur conserve alors l'ancienne URL dans
    // son index. Sur une redirection définitive, c'est l'inverse de l'effet voulu.
    const temporary = chain.filter(hop => hop.status === 302 || hop.status === 307);
    if (temporary.length > 0) {
      items.push({
        key: 'REDIRECTS.temporary',
        label: `${temporary.length} redirection(s) temporaire(s)`,
        status: 'warning',
        detail: temporary.map(hop => `${hop.status} ${hop.url}`).join(', '),
      });
      recommendations.push(
        'Utiliser une 301 pour une redirection définitive : une 302 laisse l’ancienne URL indexée.',
      );
    }

    const verdict = verdictOf(items);
    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      globalScore: verdict.globalScore,
      status: verdict.status,
      items,
      summary: `${chain.length} redirection(s) avant la page finale.`,
      recommendations,
    });
  }
}
