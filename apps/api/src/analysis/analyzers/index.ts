import type { BaseAnalyzer } from '../base.analyzer.js';
import { CanonicalAnalyzer } from './canonical.analyzer.js';
import { ContentLengthAnalyzer } from './content-length.analyzer.js';
import { HnAnalyzer } from './hn.analyzer.js';
import { LangAnalyzer } from './lang.analyzer.js';
import { MetasAnalyzer } from './metas.analyzer.js';
import { OpenGraphAnalyzer } from './opengraph.analyzer.js';
import { RedirectsAnalyzer } from './redirects.analyzer.js';

/**
 * Analyseurs actifs, dans l'ordre d'exécution.
 *
 * Ils tournent en PARALLÈLE : l'ordre ne fixe que celui du rapport. Aucun
 * analyseur ne dépend du résultat d'un autre — c'est ce qui rend la
 * parallélisation sûre et la liste extensible sans effet de bord.
 */
export function createAnalyzers(): BaseAnalyzer[] {
  return [
    new MetasAnalyzer(),
    new HnAnalyzer(),
    new ContentLengthAnalyzer(),
    new CanonicalAnalyzer(),
    new OpenGraphAnalyzer(),
    new LangAnalyzer(),
    new RedirectsAnalyzer(),
  ];
}

/** Identifiants des critères effectivement portés. */
export function analyzerIds(): string[] {
  return createAnalyzers().map(analyzer => analyzer.id);
}
