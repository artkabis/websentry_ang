import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { AnalysisReport, SseBatchEvent } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { BatchComponent } from './batch.component';

const BATCH = '11111111-1111-4111-8111-111111111111';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function report(url: string, globalScore = 4): AnalysisReport {
  return {
    analyzeId: '22222222-2222-4222-8222-222222222222',
    url,
    title: 'Page',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 900,
    globalScore,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 80,
    redirectChain: [],
    htmlSize: 900,
    httpHeaders: {},
    dudaParams: null,
    checks: {
      METAS: {
        checkId: 'METAS',
        checkTitle: 'Balises méta',
        globalScore,
        status: globalScore >= 4 ? 'pass' : 'fail',
        items: [],
        summary: 'Résumé',
        recommendations: ['Corriger'],
      },
    },
  };
}

/**
 * Flux simulé.
 *
 * `open: true` laisse le flux OUVERT après le dernier événement, ce qui simule
 * un lot encore en cours : sans cela, un flux qui se termine sans événement
 * terminal est — à juste titre — signalé comme une coupure.
 */
function streamOf(events: readonly SseBatchEvent[], options: { open?: boolean } = {}) {
  return vi.fn(async function* () {
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
    if (options.open) await new Promise(() => undefined);
  });
}

function setup(batchStream = streamOf([])) {
  return {
    batchStream,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AnalysisApi, useValue: { batchStream } },
    ],
  };
}

async function launch(
  t: ReturnType<typeof setup>,
  saisie = 'https://exemple.fr/\nhttps://exemple.fr/contact',
) {
  await render(BatchComponent, { providers: t.providers });
  await userEvent.type(screen.getByRole('textbox'), saisie);
  await userEvent.click(screen.getByRole('button', { name: 'Analyser le lot' }));
  await tick();
  await tick();
}

const page = (url: string, over: Partial<Extract<SseBatchEvent, { type: 'page' }>> = {}) =>
  ({
    type: 'page',
    batchId: BATCH,
    completed: 1,
    total: 2,
    url,
    ok: true,
    report: report(url),
    ...over,
  }) satisfies SseBatchEvent;

afterEach(() => vi.restoreAllMocks());

describe('BatchComponent', () => {
  describe('lancement', () => {
    it('n’active le bouton qu’avec au moins une adresse', async () => {
      const t = setup();
      await render(BatchComponent, { providers: t.providers });

      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser le lot' }).disabled,
      ).toBe(true);
      await userEvent.type(screen.getByRole('textbox'), 'https://exemple.fr/');
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser le lot' }).disabled,
      ).toBe(false);
    });

    it('DÉDOUBLONNE les adresses saisies', async () => {
      // La même page deux fois ne décrit qu'une page : l'API l'écarte déjà, et
      // l'écran doit annoncer ce qui sera réellement analysé.
      const t = setup(streamOf([], { open: true }));
      await launch(t, 'https://exemple.fr/\nhttps://exemple.fr/\nhttps://exemple.fr/contact');

      expect(t.batchStream).toHaveBeenCalledWith(
        ['https://exemple.fr/', 'https://exemple.fr/contact'],
        undefined,
        expect.anything(),
      );
    });

    it('PRÉVIENT au-delà du plafond, sans laisser partir le lot', async () => {
      const t = setup();
      const trop = Array.from({ length: 201 }, (_, i) => `https://exemple.fr/p${i}`).join('\n');
      await render(BatchComponent, { providers: t.providers });
      await userEvent.type(screen.getByRole('textbox'), trop.slice(0, 40));
      // La saisie caractère par caractère serait interminable : on force la valeur.
      const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
      textarea.value = trop;
      textarea.dispatchEvent(new Event('input'));
      await tick();

      expect(screen.getByText(/le maximum est de 200/)).toBeTruthy();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser le lot' }).disabled,
      ).toBe(true);
    });
  });

  describe('progression', () => {
    it('affiche les pages AU FIL DE L’EAU, sans attendre la fin', async () => {
      // C'est la raison d'être du flux : un lot de deux cents pages demande
      // plusieurs minutes, et une réponse unique laisserait l'écran figé.
      const t = setup(
        streamOf([{ type: 'start', batchId: BATCH, total: 2 }, page('https://exemple.fr/')], {
          open: true,
        }),
      );
      await launch(t);

      expect(screen.getByText('https://exemple.fr/')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 page(s) sur 2');
    });

    it('mesure la progression sur les pages TERMINÉES', async () => {
      const t = setup(
        streamOf(
          [{ type: 'start', batchId: BATCH, total: 4 }, page('https://exemple.fr/', { total: 4 })],
          { open: true },
        ),
      );
      await launch(t);

      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
      expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('4');
    });

    it('signale une page en ÉCHEC sans interrompre le lot', async () => {
      const t = setup(
        streamOf([
          { type: 'start', batchId: BATCH, total: 2 },
          page('https://exemple.fr/morte', { ok: false, report: null }),
          page('https://exemple.fr/', { completed: 2 }),
          { type: 'complete', batchId: BATCH, total: 2, succeeded: 1, failed: 1, durationMs: 10 },
        ]),
      );
      await launch(t);

      expect(screen.getByText('Analyse impossible')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 en échec');
    });
  });

  describe('lecture des résultats', () => {
    it('DÉPLIE le rapport d’une page dans le composant commun', async () => {
      // Aucun rendu n'est réécrit pour le lot : c'est le composant de l'analyse
      // unitaire qui sert.
      const t = setup(
        streamOf([
          { type: 'start', batchId: BATCH, total: 1 },
          page('https://exemple.fr/'),
          { type: 'complete', batchId: BATCH, total: 1, succeeded: 1, failed: 0, durationMs: 10 },
        ]),
      );
      await launch(t);

      await userEvent.click(screen.getByRole('button', { name: /exemple\.fr/ }));
      expect(await screen.findByRole('button', { name: /^À traiter/ })).toBeTruthy();
    });

    it('n’ouvre qu’UN rapport à la fois', async () => {
      // Deux rapports dépliés ne se comparent pas : ils s'empilent.
      const t = setup(
        streamOf([
          { type: 'start', batchId: BATCH, total: 2 },
          page('https://exemple.fr/'),
          page('https://exemple.fr/contact', { completed: 2 }),
          { type: 'complete', batchId: BATCH, total: 2, succeeded: 2, failed: 0, durationMs: 10 },
        ]),
      );
      await launch(t);

      await userEvent.click(screen.getByRole('button', { name: /exemple\.fr\/$/ }));
      await userEvent.click(screen.getByRole('button', { name: /contact/ }));

      expect(screen.getAllByRole('button', { name: /^À traiter/ })).toHaveLength(1);
    });

    it('ne propose PAS de rapport pour une page en échec', async () => {
      const t = setup(
        streamOf([
          { type: 'start', batchId: BATCH, total: 1 },
          page('https://exemple.fr/morte', { ok: false, report: null }),
          { type: 'complete', batchId: BATCH, total: 1, succeeded: 0, failed: 1, durationMs: 10 },
        ]),
      );
      await launch(t);

      expect(screen.getByRole<HTMLButtonElement>('button', { name: /morte/ }).disabled).toBe(true);
    });

    it('moyenne les seules pages MESURÉES', async () => {
      // Une page en échec n'a pas de note : la compter pour zéro ferait mentir
      // la moyenne du lot.
      const t = setup(
        streamOf([
          { type: 'start', batchId: BATCH, total: 2 },
          page('https://exemple.fr/', { report: report('https://exemple.fr/', 4) }),
          page('https://exemple.fr/morte', { completed: 2, ok: false, report: null }),
          { type: 'complete', batchId: BATCH, total: 2, succeeded: 1, failed: 1, durationMs: 10 },
        ]),
      );
      await launch(t);

      expect(screen.getByText('4/5')).toBeTruthy();
    });
  });

  it('DIT qu’une connexion interrompue n’est pas un lot terminé', async () => {
    const t = setup(streamOf([{ type: 'start', batchId: BATCH, total: 3 }]));
    await launch(t);

    expect(screen.getByRole('alert').textContent).toContain('interrompue');
  });

  it('relaie une erreur émise DANS le flux', async () => {
    const t = setup(
      streamOf([{ type: 'error', batchId: BATCH, message: 'Quota de lots atteint' }]),
    );
    await launch(t);

    expect(screen.getByRole('alert').textContent).toContain('Quota de lots atteint');
  });
});
