import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { SessionComparison, SiteSession } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScansApi } from '../../core/scans/scans.api';
import { SiteSessionsComponent } from './site-sessions.component';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';

function session(over: Partial<SiteSession> = {}): SiteSession {
  return {
    sessionId: SESSION_A,
    pageCount: 3,
    avgScore: 4,
    minScore: 3,
    maxScore: 5,
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 4000,
    launchedBy: 'alice',
    ...over,
  };
}

function comparison(over: Partial<SessionComparison> = {}): SessionComparison {
  return {
    base: {
      sessionId: SESSION_A,
      analyzedAt: '2026-06-01T10:00:00.000Z',
      avgScore: 4,
      pageCount: 1,
    },
    target: {
      sessionId: SESSION_B,
      analyzedAt: '2026-06-10T10:00:00.000Z',
      avgScore: 2,
      pageCount: 1,
    },
    scoreDelta: -2,
    summary: { added: 0, removed: 1, degraded: 1, improved: 0, unchanged: 0 },
    pages: [
      {
        url: 'https://exemple.fr/',
        change: 'changed',
        baseScore: 4,
        targetScore: 2,
        scoreDelta: -2,
        degraded: 1,
        improved: 0,
        checks: [{ checkId: 'METAS', baseStatus: 'pass', targetStatus: 'fail', trend: 'degraded' }],
      },
    ],
    ...over,
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    sessions?: SiteSession[];
    siteSessions?: ReturnType<typeof vi.fn>;
    compare?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const siteSessions = opts.siteSessions ?? vi.fn().mockResolvedValue(opts.sessions ?? [session()]);
  const compare = opts.compare ?? vi.fn().mockResolvedValue(comparison());

  return {
    siteSessions,
    compare,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ScansApi, useValue: { siteSessions, compare } },
    ],
  };
}

/**
 * `gamme` est passée explicitement, sans valeur par défaut : une valeur par
 * défaut ferait retomber `mount(t, undefined)` sur elle, et le test « site sans
 * gamme » vérifierait exactement le contraire de ce qu'il annonce.
 */
async function mount(t: ReturnType<typeof setup>, gamme: string | undefined) {
  await render(SiteSessionsComponent, {
    providers: t.providers,
    inputs: { domain: 'exemple.fr', gamme },
  });
  // Deux tours : le premier laisse l'`effect` se déclencher, le second laisse
  // la promesse de chargement se résoudre.
  await tick();
  await tick();
}

afterEach(() => vi.restoreAllMocks());

describe('SiteSessionsComponent', () => {
  describe('chargement', () => {
    it('demande les audits du site avec ses coordonnées', async () => {
      const t = setup();
      await mount(t, 'premium');
      expect(t.siteSessions).toHaveBeenCalledWith('exemple.fr', 'premium');
    });

    it('TRANSMET une gamme nulle pour un site sans gamme', async () => {
      const t = setup();
      await mount(t, undefined);
      expect(t.siteSessions).toHaveBeenCalledWith('exemple.fr', null);
    });

    it('affiche les audits', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await mount(t, 'premium');
      expect(screen.getByRole('status').textContent).toContain('2 audit(s)');
    });

    it('dit clairement qu’il n’y a rien à afficher', async () => {
      const t = setup({ sessions: [] });
      await mount(t, 'premium');
      expect(await screen.findByText(/Aucun audit enregistré/)).toBeTruthy();
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      const siteSessions = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ siteSessions });
      await mount(t, 'premium');

      expect((await screen.findByRole('alert')).textContent).toContain('Impossible de charger');
      await userEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
      expect(siteSessions).toHaveBeenCalledTimes(2);
    });
  });

  describe('sélection', () => {
    it('guide l’utilisateur vers deux audits', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await mount(t, 'premium');

      expect(screen.getByText('Sélectionnez deux audits à comparer.')).toBeTruthy();
      await userEvent.click(screen.getAllByRole('checkbox')[0]!);
      expect(await screen.findByText('Sélectionnez un second audit.')).toBeTruthy();
    });

    it('DÉSACTIVE les cases restantes au-delà de deux', async () => {
      // Laisser cocher un troisième audit qui serait ensuite ignoré est un
      // mensonge d'interface.
      const t = setup({
        sessions: [session(), session({ sessionId: SESSION_B }), session({ sessionId: SESSION_C })],
      });
      await mount(t, 'premium');

      const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
      await userEvent.click(boxes[0]!);
      await userEvent.click(boxes[1]!);

      expect(boxes[2]!.disabled).toBe(true);
      expect(boxes[0]!.disabled).toBe(false);
    });

    it('permet de désélectionner', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await mount(t, 'premium');

      const box = screen.getAllByRole<HTMLInputElement>('checkbox')[0]!;
      await userEvent.click(box);
      await userEvent.click(box);

      expect(await screen.findByText('Sélectionnez deux audits à comparer.')).toBeTruthy();
    });

    it('n’active « Comparer » qu’à deux audits sélectionnés', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await mount(t, 'premium');

      const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Comparer' });
      expect(button.disabled).toBe(true);

      await userEvent.click(screen.getAllByRole('checkbox')[0]!);
      await userEvent.click(screen.getAllByRole('checkbox')[1]!);

      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Comparer' }).disabled).toBe(
        false,
      );
    });
  });

  describe('comparaison', () => {
    async function selectTwoAndCompare(t: ReturnType<typeof setup>) {
      await mount(t, 'premium');
      await userEvent.click(screen.getAllByRole('checkbox')[0]!);
      await userEvent.click(screen.getAllByRole('checkbox')[1]!);
      await userEvent.click(screen.getByRole('button', { name: 'Comparer' }));
      await tick();
    }

    it('appelle l’API avec les deux audits retenus', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await selectTwoAndCompare(t);
      expect(t.compare).toHaveBeenCalledWith(SESSION_A, SESSION_B);
    });

    it('résume l’évolution en chiffres', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await selectTwoAndCompare(t);

      const section = await screen.findByRole('region', { name: /Évolution entre deux audits/ });
      expect(within(section).getByText('Dégradées')).toBeTruthy();
      expect(within(section).getByText('Disparues')).toBeTruthy();
    });

    it('PORTE le signe du delta — il en est le sens', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await selectTwoAndCompare(t);
      expect((await screen.findByText(/score moyen −2,0/)).textContent).toBeTruthy();
    });

    it('détaille les critères qui ont reculé', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await selectTwoAndCompare(t);
      expect(await screen.findByText(/METAS : pass → fail/)).toBeTruthy();
    });

    it('dit quand deux audits n’ont aucune page comparable', async () => {
      const compare = vi.fn().mockResolvedValue(
        comparison({
          pages: [],
          summary: { added: 0, removed: 0, degraded: 0, improved: 0, unchanged: 0 },
        }),
      );
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })], compare });
      await selectTwoAndCompare(t);

      expect(await screen.findByText(/Aucune page comparable/)).toBeTruthy();
    });

    it('signale l’échec d’une comparaison sans effacer la liste', async () => {
      const compare = vi.fn().mockRejectedValue(new Error('400'));
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })], compare });
      await selectTwoAndCompare(t);

      expect((await screen.findByRole('alert')).textContent).toContain('comparaison a échoué');
      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    });

    it('efface la sélection ET le résultat', async () => {
      const t = setup({ sessions: [session(), session({ sessionId: SESSION_B })] });
      await selectTwoAndCompare(t);

      await userEvent.click(screen.getByRole('button', { name: /Effacer la sélection/ }));

      expect(screen.queryByRole('region', { name: /Évolution/ })).toBeNull();
      expect(screen.getByText('Sélectionnez deux audits à comparer.')).toBeTruthy();
    });
  });
});
