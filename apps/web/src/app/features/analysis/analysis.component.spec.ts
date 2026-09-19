import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { AnalysisReport, CheckResult, CheckStatus, SseAnalyzeEvent } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { AnalysisComponent } from './analysis.component';

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function check(checkId: string, status: CheckStatus, over: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId,
    checkTitle: `Critère ${checkId}`,
    globalScore: status === 'fail' ? 1 : 5,
    status,
    items: [],
    summary: `Résumé de ${checkId}`,
    recommendations: [`Corriger ${checkId}`],
    ...over,
  };
}

function report(checks: CheckResult[], globalScore = 2): AnalysisReport {
  return {
    analyzeId: ANALYZE_ID,
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore,
    platform: 'generic',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    htmlSize: 100,
    httpHeaders: {},
    dudaParams: null,
    checks: Object.fromEntries(checks.map(item => [item.checkId, item])),
  };
}

/**
 * Flux simulé.
 *
 * `open: true` laisse le flux OUVERT après le dernier événement, ce qui simule
 * une analyse encore en cours. Sans cela, un flux qui se termine sans événement
 * terminal est — à juste titre — signalé comme une coupure par le composant, et
 * les tests de progression observeraient un état d'erreur au lieu de l'état
 * transitoire qu'ils visent.
 */
function streamOf(events: readonly SseAnalyzeEvent[], options: { open?: boolean } = {}) {
  return vi.fn(async function* () {
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
    if (options.open) await new Promise(() => undefined);
  });
}

function setup(stream = streamOf([])) {
  return {
    stream,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AnalysisApi, useValue: { stream } },
    ],
  };
}

async function launch(t: ReturnType<typeof setup>, url = 'https://exemple.fr/') {
  await render(AnalysisComponent, { providers: t.providers });
  await userEvent.type(screen.getByRole('textbox'), url);
  await userEvent.click(screen.getByRole('button', { name: 'Analyser' }));
  await tick();
  await tick();
}

afterEach(() => vi.restoreAllMocks());

describe('AnalysisComponent', () => {
  describe('lancement', () => {
    it('n’active le bouton qu’avec une adresse', async () => {
      const t = setup();
      await render(AnalysisComponent, { providers: t.providers });

      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser' }).disabled).toBe(
        true,
      );
      await userEvent.type(screen.getByRole('textbox'), 'https://exemple.fr/');
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser' }).disabled).toBe(
        false,
      );
    });

    it('transmet l’adresse saisie, élaguée', async () => {
      const t = setup();
      await launch(t, '  https://exemple.fr/  ');
      expect(t.stream).toHaveBeenCalledWith({ url: 'https://exemple.fr/' }, expect.anything());
    });
  });

  describe('progression', () => {
    it('MESURE la progression sur les critères terminés', async () => {
      // Une barre estimée ment dès que le site analysé est lent.
      const t = setup(
        streamOf(
          [
            { type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 4 },
            {
              type: 'check',
              analyzeId: ANALYZE_ID,
              completed: 1,
              total: 4,
              result: check('A', 'pass'),
            },
          ],
          { open: true },
        ),
      );
      await launch(t);

      const bar = await screen.findByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('1');
      expect(bar.getAttribute('aria-valuemax')).toBe('4');
    });

    it('annonce l’avancement aux technologies d’assistance', async () => {
      const t = setup(
        streamOf(
          [
            { type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 4 },
            {
              type: 'check',
              analyzeId: ANALYZE_ID,
              completed: 2,
              total: 4,
              result: check('A', 'pass'),
            },
          ],
          { open: true },
        ),
      );
      await launch(t);
      expect(screen.getByRole('status').textContent).toContain('2 critère(s) sur 4');
    });

    it('affiche les critères AU FIL DE L’EAU', async () => {
      const t = setup(
        streamOf(
          [
            { type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 2 },
            {
              type: 'check',
              analyzeId: ANALYZE_ID,
              completed: 1,
              total: 2,
              result: check('METAS', 'fail'),
            },
          ],
          { open: true },
        ),
      );
      await launch(t);
      expect(await screen.findByText('Critère METAS')).toBeTruthy();
    });
  });

  describe('verdict', () => {
    it('affiche le score et son qualificatif EN TOUTES LETTRES', async () => {
      // La couleur du cadran est invisible pour un lecteur d'écran.
      const t = setup(
        streamOf([
          {
            type: 'complete',
            analyzeId: ANALYZE_ID,
            report: report([check('METAS', 'fail')], 1.5),
          },
        ]),
      );
      await launch(t);

      expect(await screen.findByRole('heading', { name: 'Corrections urgentes' })).toBeTruthy();
      expect(screen.getByRole('img', { name: /Score 1,5 sur 5/ })).toBeTruthy();
    });

    it('CLASSE les corrections prioritaires par gravité', async () => {
      const t = setup(
        streamOf([
          {
            type: 'complete',
            analyzeId: ANALYZE_ID,
            report: report([check('METAS', 'warning'), check('CANONICAL', 'fail')]),
          },
        ]),
      );
      await launch(t);

      const list = await screen.findByRole('list', { name: '' }).catch(() => null);
      expect(list ?? screen.getByText('Corriger CANONICAL')).toBeTruthy();
      expect(screen.getByText('Corriger CANONICAL')).toBeTruthy();
    });
  });

  describe('filtre du rapport', () => {
    const mixed = report([
      check('METAS', 'fail'),
      check('CANONICAL', 'pass'),
      check('LANG', 'pass'),
    ]);

    it('N’AFFICHE par défaut que ce qui demande une action', async () => {
      // Le choix central du remaniement : un rapport qui s'ouvre sur les
      // problèmes se lit, un rapport qui s'ouvre sur les réussites se survole.
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: mixed }]));
      await launch(t);

      // On vise le bouton dépliant de la carte : le titre du critère apparaît
      // aussi dans les priorités, où sa présence ne prouve rien du filtre.
      expect(await screen.findByRole('button', { name: /Critère METAS/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Critère CANONICAL/ })).toBeNull();
    });

    it('DIT combien de critères sont masqués, MÊME quand tout un groupe disparaît', async () => {
      // CANONICAL et LANG sont tous deux conformes : leur groupe entier est
      // filtré. Un décompte posé à l'intérieur du groupe disparaîtrait avec lui
      // et l'utilisateur ne saurait rien de ces deux critères.
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: mixed }]));
      await launch(t);
      expect(
        await screen.findByText(/2 critère\(s\) conforme\(s\) ou non applicable\(s\) masqué/),
      ).toBeTruthy();
    });

    it('révèle tout à la demande', async () => {
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: mixed }]));
      await launch(t);

      await userEvent.click(screen.getByRole('button', { name: /^Tout/ }));
      expect(await screen.findByRole('button', { name: /Critère CANONICAL/ })).toBeTruthy();
    });

    it('PROPOSE le rapport complet quand rien ne demande d’action', async () => {
      // Un écran vide sans explication laisse croire à une panne.
      const clean = report([check('METAS', 'pass'), check('LANG', 'pass')], 5);
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: clean }]));
      await launch(t);

      expect(await screen.findByText(/Aucun critère ne demande d'action/)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /Afficher les 2 critères/ }));
      expect(await screen.findByRole('button', { name: /Critère METAS/ })).toBeTruthy();
    });
  });

  describe('résumé des familles', () => {
    it('énonce les décomptes EN TOUTES LETTRES', async () => {
      // La couleur ne porte jamais seule l'information : un groupe se lit même
      // sans voir les pastilles.
      const mixed = report([
        check('METAS', 'fail'),
        check('HN_STRUCTURE', 'warning'),
        check('BOLD', 'pass'),
        check('CONTENT_LENGTH', 'na'),
      ]);
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: mixed }]));
      await launch(t);

      await userEvent.click(screen.getByRole('button', { name: /^Tout/ }));
      const seo = await screen.findByRole('region', { name: 'SEO' });
      expect(within(seo).getByText(/1 en échec/)).toBeTruthy();
      expect(within(seo).getByText(/non applicable/)).toBeTruthy();
    });
  });

  describe('détail d’un critère', () => {
    it('reste REPLIÉ tant qu’on ne l’ouvre pas', async () => {
      const withItems = report([
        check('METAS', 'fail', {
          items: [{ label: 'Title manquant', status: 'fail' }],
        }),
      ]);
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: withItems }]));
      await launch(t);

      const toggle = await screen.findByRole('button', { name: /Critère METAS/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Title manquant')).toBeNull();
    });

    it('montre les RECOMMANDATIONS puis le détail', async () => {
      const withItems = report([
        check('METAS', 'fail', {
          items: [{ label: 'Title manquant', status: 'fail' }],
          recommendations: ['Ajouter une balise title'],
        }),
      ]);
      const t = setup(streamOf([{ type: 'complete', analyzeId: ANALYZE_ID, report: withItems }]));
      await launch(t);

      await userEvent.click(await screen.findByRole('button', { name: /Critère METAS/ }));

      const panel = screen
        .getByRole('button', { name: /Critère METAS/ })
        .getAttribute('aria-controls');
      expect(panel).toBeTruthy();
      expect(within(document.getElementById(panel!)!).getByText('Que faire')).toBeTruthy();
      expect(screen.getByText('Title manquant')).toBeTruthy();
    });
  });

  describe('interruption', () => {
    it('PERMET d’interrompre une analyse en cours', async () => {
      // Une analyse peut durer ; l'utilisateur qui s'est trompé d'URL ne doit
      // pas attendre qu'elle s'achève pour en relancer une autre.
      const t = setup(
        streamOf([{ type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 4 }], {
          open: true,
        }),
      );
      await launch(t);

      await userEvent.click(screen.getByRole('button', { name: 'Interrompre' }));

      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Saisissez une adresse');
      // Aucune erreur affichée : interrompre est une décision, pas une panne.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('n’affiche rien tant qu’aucune analyse n’a eu lieu', async () => {
      const t = setup();
      await render(AnalysisComponent, { providers: t.providers });

      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Saisissez une adresse');
    });
  });

  describe('erreurs', () => {
    it('affiche un message assaini et propose de réessayer', async () => {
      const t = setup(streamOf([{ type: 'error', analyzeId: null, message: 'URL injoignable' }]));
      await launch(t);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('URL injoignable');
      expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    });

    it('SIGNALE un flux coupé avant la fin', async () => {
      // Sans cela, la barre resterait figée et l'utilisateur attendrait
      // indéfiniment un rapport qui n'arrivera jamais.
      const t = setup(
        streamOf([{ type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: 4 }]),
      );
      await launch(t);

      expect((await screen.findByRole('alert')).textContent).toContain('interrompue');
    });

    it('relaie un échec du client', async () => {
      // Le client lève AVANT d'émettre quoi que ce soit : c'est le cas d'un
      // 503 ou d'un refus CSRF, où la réponse n'est même pas un flux.
      const failing = vi.fn(() => {
        throw new Error('Analyse impossible (503)');
      });
      const t = setup(failing);
      await launch(t);

      expect((await screen.findByRole('alert')).textContent).toContain('503');
    });
  });
});
