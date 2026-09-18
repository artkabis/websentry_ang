import type { AnalysisSettings } from '@websentry/shared';
import type { EffectiveSettings } from './effective-settings.js';

/**
 * Règles par page — fonctions PURES.
 *
 * Un profil de gamme s'applique à tout un site, mais certaines pages appellent
 * des exceptions : une page de contact n'a pas à contenir 300 mots, une page
 * légale n'a pas à porter de CTA. Les règles fusionnent ces exceptions dans les
 * réglages effectifs, le temps d'une analyse.
 *
 * Les réglages produits sont ÉPHÉMÈRES : ils ne sont jamais réécrits en base.
 * C'est essentiel — sans cela, analyser une page de contact modifierait
 * durablement le profil de toute la gamme.
 */

/**
 * Une règle s'applique-t-elle à cette URL ?
 *
 * `/` ne désigne que la racine ; tout autre motif est cherché comme
 * sous-chaîne dans les SEGMENTS du chemin, jamais dans le chemin entier. La
 * nuance compte : un motif `contact` ne doit pas capturer
 * `/prise-de-contact-commercial/equipe`, mais doit capturer `/nous-contacter`.
 */
export function ruleMatches(patterns: readonly string[], pathname: string): boolean {
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  const isRoot = segments.length === 0;

  return patterns.some(pattern => {
    if (!pattern) return false;
    if (pattern === '/') return isRoot;
    const needle = pattern.toLowerCase();
    return segments.some(segment => segment.includes(needle));
  });
}

/**
 * Fusionne dans les réglages les règles dont le motif correspond à l'URL.
 *
 * Retourne l'objet d'origine quand aucune règle ne s'applique — le cas courant,
 * et celui qu'on ne veut pas payer d'une copie sur chaque page d'un lot.
 */
export function applyPageRules(url: string, settings: AnalysisSettings): EffectiveSettings {
  const rules = settings.pageRules;
  if (!rules || rules.length === 0) return settings;

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // URL illisible : on n'invente pas de correspondance, on applique le profil
    // tel quel plutôt que de faire échouer l'analyse entière.
    return settings;
  }

  const matching = rules.filter(rule => ruleMatches(rule.patterns, pathname));
  if (matching.length === 0) return settings;

  let effective: EffectiveSettings = { ...settings };

  for (const rule of matching) {
    if (rule.disabledChecks && rule.disabledChecks.length > 0) {
      // Les désactivations s'ACCUMULENT : deux règles applicables désactivent
      // l'union de leurs critères, jamais seulement ceux de la dernière.
      effective = {
        ...effective,
        disabledChecks: [...(effective.disabledChecks ?? []), ...rule.disabledChecks],
      };
    }

    if (rule.settings?.content) {
      effective = {
        ...effective,
        content: { ...effective.content, ...rule.settings.content },
      };
    }

    if (rule.settings?.h1 || rule.settings?.h2) {
      effective = {
        ...effective,
        hnByTag: {
          ...effective.hnByTag,
          ...(rule.settings.h1
            ? { h1: { ...(effective.hnByTag?.h1 ?? {}), ...rule.settings.h1 } }
            : {}),
          ...(rule.settings.h2
            ? { h2: { ...(effective.hnByTag?.h2 ?? {}), ...rule.settings.h2 } }
            : {}),
        },
      };
    }
  }

  return effective;
}
