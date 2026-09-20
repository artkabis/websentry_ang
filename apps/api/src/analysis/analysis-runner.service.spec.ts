import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultAnalysisSettings } from '@websentry/shared';
import type { AppConfigService } from '../config/app-config.service.js';
import type { SsrfService } from '../security/ssrf.service.js';
import { AnalysisRunnerService } from './analysis-runner.service.js';
import type { SerializablePage } from './page.model.js';
import { clearProbeCache } from './probe-engine.js';

const PAGE: SerializablePage = {
  url: 'https://exemple.fr/',
  html: '<html lang="fr"><head><title>Accueil</title></head><body><h1>A</h1></body></html>',
  title: 'Accueil',
  platform: 'generic',
  headers: {},
  statusCode: 200,
  ttfb: 10,
  redirectChain: [],
};

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

function build(workersEnabled: boolean) {
  const config = {
    analysis: { workersEnabled, maxWorkers: 1, batchConcurrency: 4 },
    fetchTimeoutMs: 5_000,
    fetchUserAgent: 'WebSentry/2.0 (tests)',
  } as unknown as AppConfigService;
  // La politique SSRF n'est jamais sollicitée ici : aucun des critères de ce
  // jeu de pages ne sort sur le réseau. La passer quand même garde le service
  // construit comme en production.
  const ssrf = { safeFetch: vi.fn(), readTextCapped: vi.fn() } as unknown as SsrfService;
  return new AnalysisRunnerService(config, ssrf);
}

/** Page portant un lien externe — de quoi faire sortir le critère des liens. */
function pageLinking(url: string, to: string): SerializablePage {
  return {
    ...PAGE,
    url,
    html: `<html lang="fr"><head><title>T</title></head><body><h1>A</h1><a href="${to}">Menu</a></body></html>`,
  };
}

describe('AnalysisRunnerService', () => {
  describe('sortie réseau partagée', () => {
    it('ne vérifie qu’UNE FOIS un lien commun à deux pages', async () => {
      // Le menu et le pied de page sont les mêmes sur tout un site : les
      // revérifier à chaque page d'un lot dépense du réseau pour rien, et
      // inflige au site audité une charge que l'audit n'exige pas.
      clearProbeCache();
      const config = {
        analysis: { workersEnabled: false, maxWorkers: 1, batchConcurrency: 4 },
        fetchTimeoutMs: 5_000,
        fetchUserAgent: 'WebSentry/2.0 (tests)',
      } as unknown as AppConfigService;
      const safeFetch = vi.fn().mockResolvedValue({
        response: { status: 200, ok: true, headers: { get: () => null } },
        finalUrl: 'https://ailleurs.fr/commun',
        redirectChain: [],
        redirected: false,
        dispose: () => undefined,
      });
      const runner = new AnalysisRunnerService(config, {
        safeFetch,
        readTextCapped: vi.fn().mockResolvedValue(''),
      } as unknown as SsrfService);

      const settings = defaultAnalysisSettings();
      await runner.run(
        pageLinking('https://exemple.fr/a', 'https://ailleurs.fr/commun'),
        settings,
        ANALYZE_ID,
      );
      await runner.run(
        pageLinking('https://exemple.fr/b', 'https://ailleurs.fr/commun'),
        settings,
        ANALYZE_ID,
      );

      const visited = safeFetch.mock.calls.filter(([url]) => url === 'https://ailleurs.fr/commun');
      expect(visited).toHaveLength(1);
    });
  });

  describe('repli en ligne', () => {
    it('analyse sur le thread courant quand le pool est désactivé', async () => {
      // Le repli n'est pas une commodité de test : sur un hébergement sans
      // `worker_threads`, l'analyse doit rester possible, plus lentement.
      const report = await build(false).run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      expect(report.analyzeId).toBe(ANALYZE_ID);
      expect(Object.keys(report.checks).length).toBeGreaterThan(0);
    });

    it('remonte la progression en repli', async () => {
      const seen: number[] = [];
      await build(false).runWithProgress(
        PAGE,
        defaultAnalysisSettings(),
        ANALYZE_ID,
        (_result, completed) => seen.push(completed),
      );
      expect(seen.length).toBeGreaterThan(0);
    });

    it('ne démarre AUCUN thread quand le pool est désactivé', async () => {
      const runner = build(false);
      await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      // Rien à détruire : la destruction doit rester sans effet.
      await expect(runner.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('pool de threads', () => {
    it('REFUSE de démarrer le pool quand le worker n’est pas compilé', async () => {
      // Le worker est du JavaScript compilé : un thread Piscina est un vrai
      // thread Node, sans transformation TypeScript. En développement et sous
      // les tests, le fichier n'existe pas — l'analyse doit alors se faire en
      // ligne, et le dire une fois plutôt qu'échouer à chaque page.
      const runner = build(true);
      const report = await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);

      expect(report.analyzeId).toBe(ANALYZE_ID);
      expect(Reflect.get(runner, 'pool')).toBeNull();
      expect(Reflect.get(runner, 'poolFailed')).toBe(true);
      await runner.onModuleDestroy();
    });

    it('ne retente pas la création du pool à chaque analyse', async () => {
      const runner = build(true);
      const spy = vi.spyOn(runner as unknown as { workerPath: () => string }, 'workerPath');

      await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);

      expect(spy).toHaveBeenCalledTimes(1);
      await runner.onModuleDestroy();
    });

    it('utilise RÉELLEMENT un thread quand le worker est compilé', async () => {
      // Le seul test qui prouve que le chemin worker fonctionne : il pointe le
      // pool vers le worker bâti. Sans lui, tous les autres passeraient par le
      // repli en ligne — et « le pool marche » ne serait jamais vérifié.
      // La CI bâtit le backend AVANT cette suite, précisément pour que ce test
      // ne prenne jamais une branche de repli qui ne prouverait rien.
      const compiled = resolve(import.meta.dirname, '../../dist/analysis/analysis.worker.js');
      expect(existsSync(compiled)).toBe(true);

      const runner = build(true);
      vi.spyOn(runner as unknown as { workerPath: () => string }, 'workerPath').mockReturnValue(
        compiled,
      );
      try {
        const report = await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
        expect(Reflect.get(runner, 'pool')).not.toBeNull();
        expect(report.analyzeId).toBe(ANALYZE_ID);
        expect(Object.keys(report.checks).length).toBeGreaterThan(0);
      } finally {
        await runner.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('défaillance du pool', () => {
    it('RETOMBE en ligne plutôt que d’échouer', async () => {
      const runner = build(true);
      // Le pool est remplacé par un double qui refuse toute tâche.
      const failing = {
        run: vi.fn().mockRejectedValue(new Error('worker mort')),
        destroy: vi.fn(),
      };
      Reflect.set(runner, 'pool', failing);

      const report = await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      expect(report.analyzeId).toBe(ANALYZE_ID);
      expect(failing.run).toHaveBeenCalled();
    });

    it('ne réessaie PAS le pool après une défaillance', async () => {
      // Réessayer à chaque page multiplierait le coût d'un pool cassé.
      const runner = build(true);
      const failing = {
        run: vi.fn().mockRejectedValue(new Error('worker mort')),
        destroy: vi.fn(),
      };
      Reflect.set(runner, 'pool', failing);

      await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      await runner.run(PAGE, defaultAnalysisSettings(), ANALYZE_ID);
      expect(failing.run).toHaveBeenCalledTimes(1);
    });

    it('retombe en ligne aussi sur le chemin de progression', async () => {
      const runner = build(true);
      const failing = {
        run: vi.fn().mockRejectedValue(new Error('worker mort')),
        destroy: vi.fn(),
      };
      Reflect.set(runner, 'pool', failing);

      const seen: number[] = [];
      const report = await runner.runWithProgress(
        PAGE,
        defaultAnalysisSettings(),
        ANALYZE_ID,
        (_r, completed) => seen.push(completed),
      );
      expect(report.analyzeId).toBe(ANALYZE_ID);
      expect(seen.length).toBeGreaterThan(0);
    });
  });
});
