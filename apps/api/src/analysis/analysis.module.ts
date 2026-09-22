import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ScansModule } from '../scans/scans.module.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisRunnerService } from './analysis-runner.service.js';
import { AnalysisService } from './analysis.service.js';
import { PageFetcherService } from './page-fetcher.service.js';
import { SitemapService } from './sitemap.service.js';

/**
 * Module 4 — moteur d'analyse.
 *
 * Il ne réimplémente rien de ce que les modules précédents portent : la
 * politique SSRF vient du socle de sécurité (module 1), les réglages du module
 * 2, l'historisation du module 3. Ce module est l'endroit où ces trois briques
 * se rencontrent autour d'une page à analyser.
 */
@Module({
  imports: [ProfilesModule, ScansModule, RbacModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisRunnerService, PageFetcherService, SitemapService],
  exports: [AnalysisService, AnalysisRunnerService],
})
export class AnalysisModule {}
