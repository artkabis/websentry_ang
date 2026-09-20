import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAnalysisSettings, type AnalysisReport } from '@websentry/shared';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import type { ScansService } from '../scans/scans.service.js';
import { AnalysisService, hostnameOf, orderByRequest } from './analysis.service.js';
import type { AnalysisRunnerService } from './analysis-runner.service.js';
import type { PageFetcherService } from './page-fetcher.service.js';
import type { SerializablePage } from './page.model.js';

const ACTOR = { username: 'alice', canChooseProfile: true };
const TESTER = { username: 'bob', canChooseProfile: false };

function page(over: Partial<SerializablePage> = {}): SerializablePage {
  return {
    url: 'https://exemple.fr/',
    html: '<html><body></body></html>',
    title: 'Accueil',
    platform: 'generic',
    headers: {},
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    ...over,
  };
}

function report(over: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    analyzeId: '11111111-1111-4111-8111-111111111111',
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore: 4,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    htmlSize: 100,
    httpHeaders: {},
    dudaParams: null,
    checks: {},
    ...over,
  };
}

function build(over: { batchConcurrency?: number } = {}) {
  const fetcher = { fetchPage: vi.fn().mockResolvedValue(page()) };
  const runner = {
    run: vi
      .fn()
      .mockImplementation((p: SerializablePage) => Promise.resolve(report({ url: p.url }))),
    runWithProgress: vi.fn().mockResolvedValue(report()),
  };
  const profiles = {
    resolveSettings: vi
      .fn()
      .mockResolvedValue({ profile: 'default', settings: defaultAnalysisSettings() }),
  };
  const scans = { record: vi.fn().mockResolvedValue(undefined) };
  const config = { analysis: { batchConcurrency: over.batchConcurrency ?? 4 } };

  const service = new AnalysisService(
    fetcher as unknown as PageFetcherService,
    runner as unknown as AnalysisRunnerService,
    profiles as unknown as ProfilesService,
    scans as unknown as ScansService,
    config as unknown as AppConfigService,
  );
  return { service, fetcher, runner, profiles, scans };
}

describe('AnalysisService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('analyse d’une page', () => {
    it('récupère la page, l’analyse et l’historise', async () => {
      await t.service.analyzePage('https://exemple.fr/', ACTOR);
      expect(t.fetcher.fetchPage).toHaveBeenCalledWith('https://exemple.fr/');
      expect(t.runner.run).toHaveBeenCalled();
      expect(t.scans.record).toHaveBeenCalled();
    });

    it('emprunte le chemin de progression quand un rappel est fourni', async () => {
      await t.service.analyzePage('https://exemple.fr/', ACTOR, {}, () => undefined);
      expect(t.runner.runWithProgress).toHaveBeenCalled();
      expect(t.runner.run).not.toHaveBeenCalled();
    });

    it('honore l’identifiant imposé — le flux SSE en a besoin d’avance', async () => {
      const analyzeId = '22222222-2222-4222-8222-222222222222';
      await t.service.analyzePage('https://exemple.fr/', ACTOR, { analyzeId });
      expect(t.runner.run).toHaveBeenCalledWith(expect.anything(), expect.anything(), analyzeId);
    });
  });

  describe('résolution du profil', () => {
    const dudaPage = (gamme: string) =>
      page({ html: `<script>window.Parameters={ExternalUid:'${gamme}|ABC'}</script>` });

    it('applique le profil DÉTECTÉ dans la page', async () => {
      t.fetcher.fetchPage.mockResolvedValue(dudaPage('PREMIUM'));
      await t.service.analyzePage('https://exemple.fr/', TESTER);
      expect(t.profiles.resolveSettings).toHaveBeenCalledWith('premium');
    });

    it('retombe sur « default » sans gamme détectée', async () => {
      await t.service.analyzePage('https://exemple.fr/', TESTER);
      expect(t.profiles.resolveSettings).toHaveBeenCalledWith('default');
    });

    it('honore un profil choisi par un appelant AUTORISÉ', async () => {
      t.fetcher.fetchPage.mockResolvedValue(dudaPage('PREMIUM'));
      await t.service.analyzePage('https://exemple.fr/', ACTOR, { profileOverride: 'Start' });
      expect(t.profiles.resolveSettings).toHaveBeenCalledWith('start');
    });

    it('IGNORE le profil choisi sans permission, sans refuser l’analyse', async () => {
      // Un utilisateur sans la permission obtient son analyse, avec le profil
      // auquel il a droit — le refus serait une punition sans objet.
      t.fetcher.fetchPage.mockResolvedValue(dudaPage('PREMIUM'));
      await t.service.analyzePage('https://exemple.fr/', TESTER, { profileOverride: 'start' });
      expect(t.profiles.resolveSettings).toHaveBeenCalledWith('premium');
    });

    it('HISTORISE la gamme détectée, pas celle choisie', async () => {
      // L'historique décrit le site tel qu'il est, pas le profil avec lequel on
      // a voulu le lire.
      t.fetcher.fetchPage.mockResolvedValue(dudaPage('PREMIUM'));
      await t.service.analyzePage('https://exemple.fr/', ACTOR, { profileOverride: 'start' });
      expect(t.scans.record).toHaveBeenCalledWith(expect.objectContaining({ gamme: 'premium' }));
    });

    it('fusionne les surcharges ponctuelles par-dessus le profil', async () => {
      await t.service.analyzePage('https://exemple.fr/', ACTOR, {
        settingsOverride: { enabledChecks: ['METAS'] },
      });
      const [, settings] = t.runner.run.mock.calls[0] as [unknown, { enabledChecks?: string[] }];
      expect(settings.enabledChecks).toEqual(['METAS']);
    });
  });

  describe('historisation', () => {
    it('N’INTERROMPT PAS l’analyse quand l’historique échoue', async () => {
      // Perdre la trace d'un scan dégrade la traçabilité, pas le service rendu.
      t.scans.record.mockRejectedValue(new Error('base injoignable'));
      await expect(t.service.analyzePage('https://exemple.fr/', ACTOR)).resolves.toBeDefined();
    });

    it('rattache la session au domaine analysé', async () => {
      await t.service.analyzePage('https://exemple.fr/', ACTOR);
      expect(t.scans.record).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'exemple.fr', launchedBy: 'alice' }),
      );
    });

    it('réduit chaque rapport à son résumé de critères', async () => {
      await t.service.analyzePage('https://exemple.fr/', ACTOR);
      const [payload] = t.scans.record.mock.calls[0] as [
        { pages: Array<{ checkSummary: unknown; report: unknown }> },
      ];
      expect(payload.pages[0]?.checkSummary).toEqual({});
      expect(payload.pages[0]?.report).toBeDefined();
    });
  });

  describe('analyse d’un lot', () => {
    const urls = ['https://a.fr/', 'https://b.fr/', 'https://c.fr/'];

    it('analyse toutes les URL', async () => {
      const result = await t.service.analyzeBatch(urls, ACTOR);
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
    });

    it('n’analyse QU’UNE FOIS une URL répétée', async () => {
      // Un sitemap qui cite deux fois la même page ne décrit qu'une page : la
      // retélécharger pour lui réappliquer vingt-neuf critères ne produirait
      // qu'un second exemplaire du même rapport.
      const result = await t.service.analyzeBatch(
        ['https://a.fr/', 'https://b.fr/', 'https://a.fr/'],
        ACTOR,
      );

      expect(t.fetcher.fetchPage).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
    });

    it('RÉTABLIT l’ordre demandé', async () => {
      // Les résultats arrivent dans l'ordre d'achèvement : sans remise en
      // ordre, deux lancements identiques rendraient deux rapports
      // différemment ordonnés.
      t.fetcher.fetchPage.mockImplementation((url: string) => {
        const delay = url === 'https://a.fr/' ? 20 : 0;
        return new Promise(resolve => setTimeout(() => resolve(page({ url })), delay));
      });
      const result = await t.service.analyzeBatch(urls, ACTOR);
      expect(result.results.map(item => item.url)).toEqual(urls);
    });

    it('N’ABANDONNE PAS le lot sur l’échec d’une page', async () => {
      // Analyser cinquante pages et tout perdre parce que la douzième renvoie
      // un 500 serait absurde.
      t.fetcher.fetchPage.mockImplementation((url: string) =>
        url === 'https://b.fr/'
          ? Promise.reject(new Error('502 Bad Gateway'))
          : Promise.resolve(page({ url })),
      );
      const result = await t.service.analyzeBatch(urls, ACTOR);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results.find(item => item.url === 'https://b.fr/')).toMatchObject({
        ok: false,
        report: null,
        error: '502 Bad Gateway',
      });
    });

    it('BORNE la concurrence', async () => {
      // Deux cents analyses de front satureraient la sortie réseau et
      // déclencheraient la limitation de débit des sites analysés.
      let running = 0;
      let peak = 0;
      t.fetcher.fetchPage.mockImplementation(
        (url: string) =>
          new Promise(resolve => {
            running += 1;
            peak = Math.max(peak, running);
            setTimeout(() => {
              running -= 1;
              resolve(page({ url }));
            }, 5);
          }),
      );
      const many = Array.from({ length: 20 }, (_, i) => `https://s${i}.fr/`);
      await build({ batchConcurrency: 3 }).service.analyzeBatch(many, ACTOR);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('remonte la progression page par page', async () => {
      const seen: number[] = [];
      await t.service.analyzeBatch(urls, ACTOR, {}, (_item, completed) => seen.push(completed));
      expect(seen).toHaveLength(3);
      expect(Math.max(...seen)).toBe(3);
    });

    it('historise UNE session pour tout le lot', async () => {
      await t.service.analyzeBatch(urls, ACTOR);
      expect(t.scans.record).toHaveBeenCalledTimes(1);
      const [payload] = t.scans.record.mock.calls[0] as [{ pages: unknown[] }];
      expect(payload.pages).toHaveLength(3);
    });

    it('n’historise rien quand tout a échoué', async () => {
      t.fetcher.fetchPage.mockRejectedValue(new Error('injoignable'));
      const result = await t.service.analyzeBatch(urls, ACTOR);
      expect(result.failed).toBe(3);
      expect(t.scans.record).not.toHaveBeenCalled();
    });
  });
});

describe('hostnameOf', () => {
  it('extrait l’hôte', () => {
    expect(hostnameOf('https://exemple.fr/page?a=1')).toBe('exemple.fr');
  });

  it('retombe sur l’entrée tronquée si elle est illisible', () => {
    expect(hostnameOf('pas une url')).toBe('pas une url');
  });
});

describe('orderByRequest', () => {
  const item = (url: string) => ({ url, ok: true, report: null, error: null });

  it('rétablit l’ordre demandé', () => {
    const results = [item('b'), item('a')];
    expect(orderByRequest(results, ['a', 'b']).map(r => r.url)).toEqual(['a', 'b']);
  });

  it('ignore une URL absente des résultats', () => {
    expect(orderByRequest([item('a')], ['a', 'b'])).toHaveLength(1);
  });

  it('ne duplique pas un résultat quand l’URL est demandée deux fois', () => {
    expect(orderByRequest([item('a')], ['a', 'a'])).toHaveLength(1);
  });
});
