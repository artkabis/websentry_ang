import { Location } from '@angular/common';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { AnalysisReport, CheckResult, CheckStatus, ScanPage } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanReportPurgedError, ScansApi } from '../../core/scans/scans.api';
import { ScanDetailComponent } from './scan-detail.component';

const PAGE = '11111111-1111-4111-8111-111111111111';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function check(checkId: string, status: CheckStatus): CheckResult {
  return {
    checkId,
    checkTitle: `Critère ${checkId}`,
    globalScore: status === 'fail' ? 1 : 5,
    status,
    items: [],
    summary: `Résumé de ${checkId}`,
    recommendations: [`Corriger ${checkId}`],
  };
}

function report(checks: CheckResult[] = [check('METAS', 'fail')]): AnalysisReport {
  return {
    analyzeId: '22222222-2222-4222-8222-222222222222',
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore: 2,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    htmlSize: 1000,
    httpHeaders: {},
    dudaParams: null,
    checks: Object.fromEntries(checks.map(item => [item.checkId, item])),
  };
}

function scanPage(over: Partial<ScanPage> = {}): ScanPage {
  return {
    id: PAGE,
    sessionId: '33333333-3333-4333-8333-333333333333',
    url: 'https://exemple.fr/',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: null,
    platform: 'duda',
    globalScore: 2,
    statusCode: 200,
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    checkSummary: { METAS: 'fail', LANG: 'pass' },
    metadata: null,
    launchedBy: 'alice',
    reportState: 'inline',
    ...over,
  };
}

function setup(pageReport = vi.fn().mockResolvedValue({ scan: scanPage(), report: report() })) {
  return {
    pageReport,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ScansApi, useValue: { pageReport } },
    ],
  };
}

async function mount(t: ReturnType<typeof setup>) {
  await render(ScanDetailComponent, { providers: t.providers, inputs: { pageId: PAGE } });
  await tick();
  await tick();
}

afterEach(() => vi.restoreAllMocks());

describe('ScanDetailComponent', () => {
  it('annonce le CHARGEMENT avant d’avoir le rapport', async () => {
    const t = setup(vi.fn(() => new Promise(() => undefined)));
    await render(ScanDetailComponent, { providers: t.providers, inputs: { pageId: PAGE } });

    expect(screen.getByRole('status').textContent).toContain('Chargement');
  });

  it('rend le rapport avec le MÊME composant que l’analyse en direct', async () => {
    // Deux rendus séparés divergeraient au premier changement : un rapport relu
    // six mois plus tard doit se lire comme au jour de sa production.
    const t = setup();
    await mount(t);

    expect(t.pageReport).toHaveBeenCalledWith(PAGE);
    expect(screen.getByRole('heading', { name: 'Accueil' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^À traiter/ })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Critère METAS/ })).toBeTruthy();
  });

  describe('rapport purgé', () => {
    const purged = (over: { purgedAt?: string | null; scan?: ScanPage | null } = {}) =>
      setup(
        vi
          .fn()
          .mockRejectedValue(
            new ScanReportPurgedError(
              over.purgedAt === undefined ? '2026-01-15T03:00:00.000Z' : over.purgedAt,
              over.scan === undefined ? scanPage({ reportState: 'purged' }) : over.scan,
            ),
          ),
      );

    it('N’EST PAS présenté comme une erreur', async () => {
      // La rétention a effacé le rapport : c'est un état connu de
      // l'application, pas une panne dont l'utilisateur devrait s'inquiéter.
      await mount(purged());

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Rapport purgé' })).toBeTruthy();
    });

    it('dit QUAND la purge a eu lieu', async () => {
      await mount(purged());

      expect(screen.getByText(/15\/01\/2026/)).toBeTruthy();
    });

    it('TIENT la promesse du message : le résumé reste consultable', async () => {
      await mount(purged());

      expect(screen.getByText(/METAS/)).toBeTruthy();
      expect(screen.getByText(/en échec/)).toBeTruthy();
    });

    it('montre D’ABORD les critères en échec', async () => {
      const liste = await mount(purged()).then(() => screen.getAllByRole('listitem'));

      expect(liste[0]?.textContent).toContain('METAS');
    });

    it('reste lisible sans résumé — purge par une version antérieure', async () => {
      await mount(purged({ scan: null, purgedAt: null }));

      expect(screen.getByText(/version antérieure/)).toBeTruthy();
    });
  });

  it('permet de REPRENDRE après un échec', async () => {
    const pageReport = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service indisponible'))
      .mockResolvedValue({ scan: scanPage(), report: report() });
    const t = setup(pageReport);
    await mount(t);

    expect(screen.getByRole('alert').textContent).toContain('Service indisponible');
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await tick();

    expect(screen.getByRole('heading', { name: 'Accueil' })).toBeTruthy();
  });

  describe('filtre porté par l’adresse', () => {
    async function renderAt(path: string) {
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          // Même configuration qu'en production : sans la liaison des entrées,
          // le composant ne recevrait jamais son identifiant de page.
          provideRouter(
            [{ path: 'historique/page/:pageId', component: ScanDetailComponent }],
            withComponentInputBinding(),
          ),
          {
            provide: ScansApi,
            useValue: {
              pageReport: vi
                .fn()
                .mockResolvedValue({ scan: scanPage(), report: report([check('LANG', 'pass')]) }),
            },
          },
        ],
      });
      await RouterTestingHarness.create(path);
      await tick();
      await tick();
      return TestBed.inject(Location);
    }

    it('ROUVRE le rapport complet quand le lien le demande', async () => {
      // Le filtre voyage avec le lien : montrer « tout » à un collègue ne
      // demande pas de lui expliquer où cliquer.
      await renderAt(`/historique/page/${PAGE}?filtre=tous`);

      expect(screen.getByRole('button', { name: /^Tout/ }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    it('écrit le filtre choisi, et RIEN pour celui par défaut', async () => {
      const location = await renderAt(`/historique/page/${PAGE}`);

      expect(location.path(true)).not.toContain('filtre=');
      await userEvent.click(screen.getByRole('button', { name: /^Tout/ }));
      expect(location.path(true)).toContain('filtre=tous');
    });
  });
});
