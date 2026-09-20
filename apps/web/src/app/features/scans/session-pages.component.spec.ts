import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { SessionPage, SessionReport } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScansApi } from '../../core/scans/scans.api';
import { SessionPagesComponent } from './session-pages.component';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PAGE_A = '22222222-2222-4222-8222-222222222222';
const PAGE_B = '33333333-3333-4333-8333-333333333333';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function page(over: Partial<SessionPage> = {}): SessionPage {
  return {
    id: PAGE_A,
    url: 'https://exemple.fr/',
    globalScore: 4,
    statusCode: 200,
    analyzedAt: '2026-06-04T10:00:00.000Z',
    checkSummary: { METAS: 'pass' },
    reportState: 'inline',
    report: null,
    error: null,
    ...over,
  };
}

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    sessionId: SESSION,
    siteId: '44444444-4444-4444-8444-444444444444',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: null,
    platform: 'duda',
    launchedBy: 'alice',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 4000,
    pageCount: 1,
    avgScore: 4,
    minScore: 4,
    maxScore: 4,
    truncated: false,
    profileSnapshot: null,
    pages: [page()],
    ...over,
  };
}

function setup(session = vi.fn().mockResolvedValue(report())) {
  return {
    session,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ScansApi, useValue: { session } },
    ],
  };
}

async function mount(t: ReturnType<typeof setup>) {
  await render(SessionPagesComponent, { providers: t.providers, inputs: { sessionId: SESSION } });
  await tick();
  await tick();
}

afterEach(() => vi.restoreAllMocks());

describe('SessionPagesComponent', () => {
  it('annonce le CHARGEMENT avant d’avoir les pages', async () => {
    const t = setup(vi.fn(() => new Promise(() => undefined)));
    await render(SessionPagesComponent, { providers: t.providers, inputs: { sessionId: SESSION } });

    expect(screen.getByRole('status').textContent).toContain('Chargement');
  });

  it('liste les pages de l’audit', async () => {
    const t = setup();
    await mount(t);

    expect(t.session).toHaveBeenCalledWith(SESSION);
    expect(screen.getByRole('link', { name: /exemple\.fr/ })).toBeTruthy();
  });

  it('MÈNE au rapport de la page', async () => {
    // C'était le chaînon manquant : l'API servait le rapport, aucun écran n'y
    // menait.
    const t = setup();
    await mount(t);

    expect(screen.getByRole('link', { name: /exemple\.fr/ }).getAttribute('href')).toBe(
      `/historique/page/${PAGE_A}`,
    );
  });

  it('montre D’ABORD les pages qui vont mal', async () => {
    // Une liste triée par score décroissant ferait lire en premier ce qui va
    // bien : l'inverse de ce qu'on ouvre l'écran pour trouver.
    const t = setup(
      vi.fn().mockResolvedValue(
        report({
          pages: [
            page({ id: PAGE_A, url: 'https://exemple.fr/bonne', globalScore: 5 }),
            page({ id: PAGE_B, url: 'https://exemple.fr/faible', globalScore: 1 }),
          ],
        }),
      ),
    );
    await mount(t);

    const liens = screen.getAllByRole('link', { name: /exemple\.fr\// });
    expect(liens[0]?.getAttribute('aria-label')).toContain('/faible');
  });

  it('place les pages NON MESURÉES avant toutes les autres', async () => {
    // Une page sans score n'a pas été mesurée : c'est plus grave qu'une
    // mauvaise note, et cela se corrige en premier.
    const t = setup(
      vi.fn().mockResolvedValue(
        report({
          pages: [
            page({ id: PAGE_A, url: 'https://exemple.fr/mauvaise', globalScore: 1 }),
            page({
              id: PAGE_B,
              url: 'https://exemple.fr/echec',
              globalScore: null,
              error: 'Hôte injoignable',
            }),
          ],
        }),
      ),
    );
    await mount(t);

    const liens = screen.getAllByRole('link', { name: /exemple\.fr\// });
    expect(liens[0]?.getAttribute('aria-label')).toContain('/echec');
    expect(liens[0]?.getAttribute('aria-label')).toContain('sans score');
  });

  it('dit qu’un rapport n’est plus consultable', async () => {
    const t = setup(
      vi.fn().mockResolvedValue(report({ pages: [page({ reportState: 'purged' })] })),
    );
    await mount(t);

    expect(screen.getByRole('link', { name: /exemple\.fr/ }).textContent).toContain('purgé');
  });

  it('PRÉVIENT quand l’audit est tronqué', async () => {
    // Un lot de sitemap peut compter des milliers de pages : taire la troncature
    // laisserait croire que l'audit n'en comptait que deux cents.
    const t = setup(vi.fn().mockResolvedValue(report({ truncated: true, pageCount: 4000 })));
    await mount(t);

    expect(screen.getByText(/premières sont listées/)).toBeTruthy();
  });

  it('propose une SUITE quand l’audit est vide', async () => {
    // Un écran vide qui dit « aucune page » n'aide pas : il dit quoi faire.
    const t = setup(vi.fn().mockResolvedValue(report({ pages: [], pageCount: 0 })));
    await mount(t);

    expect(screen.getByRole('link', { name: /Lancer une nouvelle analyse/ })).toBeTruthy();
  });

  it('permet de REPRENDRE après un échec', async () => {
    const session = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service indisponible'))
      .mockResolvedValue(report());
    const t = setup(session);
    await mount(t);

    expect(screen.getByRole('alert').textContent).toContain('Service indisponible');
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await tick();

    expect(screen.getByRole('link', { name: /exemple\.fr/ })).toBeTruthy();
  });
});
