import type { BaseAnalyzer } from '../base.analyzer.js';
import { BoldAnalyzer } from './bold.analyzer.js';
import { CanonicalAnalyzer } from './canonical.analyzer.js';
import { ContentLengthAnalyzer } from './content-length.analyzer.js';
import { DudaParamsAnalyzer } from './duda-params.analyzer.js';
import { FaviconAnalyzer } from './favicon.analyzer.js';
import { HnAnalyzer } from './hn.analyzer.js';
import { HnLengthAnalyzer } from './hn-length.analyzer.js';
import { LangAnalyzer } from './lang.analyzer.js';
import { MetasAnalyzer } from './metas.analyzer.js';
import { OpenGraphAnalyzer } from './opengraph.analyzer.js';
import { RedirectsAnalyzer } from './redirects.analyzer.js';
import { RobotsMetaAnalyzer } from './robots-meta.analyzer.js';
import { TrackingAnalyzer } from './tracking.analyzer.js';

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
    new HnLengthAnalyzer(),
    new ContentLengthAnalyzer(),
    new BoldAnalyzer(),
    new CanonicalAnalyzer(),
    new OpenGraphAnalyzer(),
    new LangAnalyzer(),
    new RedirectsAnalyzer(),
    new RobotsMetaAnalyzer(),
    new TrackingAnalyzer(),
    new FaviconAnalyzer(),
    new DudaParamsAnalyzer(),
  ];
}

/** Identifiants des critères effectivement portés. */
export function analyzerIds(): string[] {
  return createAnalyzers().map(analyzer => analyzer.id);
}
