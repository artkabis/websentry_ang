import type { CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Éléments retirés avant de compter les mots.
 *
 * Sans cela, un site chargé de scripts d'analytics afficherait un « contenu »
 * de plusieurs milliers de mots dont aucun n'est lisible par un humain.
 */
const NON_CONTENT_SELECTORS = 'script, style, noscript, template, svg, iframe';

export class ContentLengthAnalyzer extends BaseAnalyzer {
  readonly id = 'CONTENT_LENGTH';
  readonly title = 'Longueur du contenu texte';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { minWords, warningWords } = settings.content;
    const words = countVisibleWords(page);

    if (words < minWords) {
      return Promise.resolve(
        this.fail(
          [
            {
              key: 'CONTENT.too_short',
              label: `Contenu trop court (${words} mots)`,
              status: 'fail',
              detail: `minimum ${minWords} mots`,
            },
          ],
          `${words} mot(s) de contenu visible, pour un minimum de ${minWords}.`,
          [`Étoffer le contenu : ${words} mots pour un minimum attendu de ${minWords}.`],
          2,
        ),
      );
    }

    if (words < warningWords) {
      return Promise.resolve(
        this.warn(
          [
            {
              key: 'CONTENT.short',
              label: `Contenu court (${words} mots)`,
              status: 'warning',
              detail: `seuil de confort ${warningWords} mots`,
            },
          ],
          `${words} mot(s) de contenu visible.`,
          [`Viser ${warningWords} mots pour un contenu confortablement indexable.`],
        ),
      );
    }

    return Promise.resolve(
      this.pass(
        [{ key: 'CONTENT.ok', label: `${words} mots de contenu`, status: 'pass' }],
        `${words} mot(s) de contenu visible.`,
      ),
    );
  }
}

/**
 * Compte les mots du contenu VISIBLE.
 *
 * Exporté pour être testé seul : le décompte décide à lui seul du verdict, et
 * une erreur d'un facteur deux y passerait inaperçue dans un test de bout en
 * bout.
 */
export function countVisibleWords(page: HtmlPage): number {
  const { $ } = page;
  // `clone()` : on ne veut pas amputer le document que d'autres analyseurs
  // liront ensuite — ils partagent la même instance Cheerio.
  const body = $('body').clone();
  body.find(NON_CONTENT_SELECTORS).remove();

  const text = body.text().replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}
