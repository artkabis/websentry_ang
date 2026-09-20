import type { BaseAnalyzer } from '../base.analyzer.js';
import { AccessibilityAnalyzer } from './accessibility.analyzer.js';
import { AnchorTextAnalyzer } from './anchor-text.analyzer.js';
import { BrokenLinksAnalyzer } from './broken-links.analyzer.js';
import { BoldAnalyzer } from './bold.analyzer.js';
import { CanonicalAnalyzer } from './canonical.analyzer.js';
import { ContentLengthAnalyzer } from './content-length.analyzer.js';
import { ContrastAnalyzer } from './contrast.analyzer.js';
import { CtaAnalyzer } from './cta.analyzer.js';
import { DataBindingAnalyzer } from './data-binding.analyzer.js';
import { DudaParamsAnalyzer } from './duda-params.analyzer.js';
import { DuplicateImagesAnalyzer } from './duplicate-images.analyzer.js';
import { FaviconAnalyzer } from './favicon.analyzer.js';
import { HnAnalyzer } from './hn.analyzer.js';
import { HnLengthAnalyzer } from './hn-length.analyzer.js';
import { ImagesAnalyzer } from './images.analyzer.js';
import { LangAnalyzer } from './lang.analyzer.js';
import { LinksAnalyzer } from './links.analyzer.js';
import { LogoAnalyzer } from './logo.analyzer.js';
import { MentionsLegalesAnalyzer } from './mentions-legales.analyzer.js';
import { MentionsLegalesDataAnalyzer } from './mentions-legales-data.analyzer.js';
import { MetasAnalyzer } from './metas.analyzer.js';
import { NavStructureAnalyzer } from './nav-structure.analyzer.js';
import { OpenGraphAnalyzer } from './opengraph.analyzer.js';
import { PictogramAnalyzer } from './pictogram.analyzer.js';
import { RedirectsAnalyzer } from './redirects.analyzer.js';
import { RobotsMetaAnalyzer } from './robots-meta.analyzer.js';
import { SplitLinksAnalyzer } from './split-links.analyzer.js';
import { StructuredDataAnalyzer } from './structured-data.analyzer.js';
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
    new CtaAnalyzer(),
    new MentionsLegalesAnalyzer(),
    new MentionsLegalesDataAnalyzer(),
    new AccessibilityAnalyzer(),
    new CanonicalAnalyzer(),
    new OpenGraphAnalyzer(),
    new LangAnalyzer(),
    new RedirectsAnalyzer(),
    new RobotsMetaAnalyzer(),
    new SplitLinksAnalyzer(),
    new LinksAnalyzer(),
    new AnchorTextAnalyzer(),
    new BrokenLinksAnalyzer(),
    new TrackingAnalyzer(),
    new StructuredDataAnalyzer(),
    new FaviconAnalyzer(),
    new LogoAnalyzer(),
    new ImagesAnalyzer(),
    new DuplicateImagesAnalyzer(),
    new PictogramAnalyzer(),
    new ContrastAnalyzer(),
    new NavStructureAnalyzer(),
    new DataBindingAnalyzer(),
    new DudaParamsAnalyzer(),
  ];
}

/** Identifiants des critères effectivement portés. */
export function analyzerIds(): string[] {
  return createAnalyzers().map(analyzer => analyzer.id);
}
