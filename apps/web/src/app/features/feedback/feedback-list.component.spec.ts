import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { of } from 'rxjs';
import type { Feedback, FeedbackCounts } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { FeedbackApi } from '../../core/feedback/feedback.api';
import { FeedbackListComponent } from './feedback-list.component';

const ID = '11111111-1111-4111-8111-111111111111';

function retour(over: Partial<Feedback> = {}): Feedback {
  return {
    id: ID,
    kind: 'bug',
    severity: 'majeur',
    status: 'nouveau',
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
    context: { route: '/profils/premium', targetUrl: null, gamme: 'premium' },
    authorId: 'u-1',
    authorName: 'bob',
    assignedTo: null,
    assignedName: null,
    resolution: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

const COMPTEURS: FeedbackCounts = {
  nouveau: 2,
  accepte: 1,
  en_cours: 0,
  resolu: 3,
  rejete: 0,
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    items?: Feedback[];
    total?: number;
    list?: ReturnType<typeof vi.fn>;
    counts?: ReturnType<typeof vi.fn>;
    triage?: ReturnType<typeof vi.fn>;
    params?: Record<string, string>;
    peutTrier?: boolean;
  } = {},
) {
  const list =
    opts.list ??
    vi.fn().mockResolvedValue({
      items: opts.items ?? [retour()],
      total: opts.total ?? opts.items?.length ?? 1,
    });
  const counts = opts.counts ?? vi.fn().mockResolvedValue(COMPTEURS);
  const triage =
    opts.triage ??
    vi.fn().mockImplementation((_id, champs) => Promise.resolve(retour({ ...champs })));

  return {
    list,
    counts,
    triage,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: FeedbackApi, useValue: { list, counts, triage } },
      {
        provide: AuthService,
        useValue: {
          hasPermission: (code: string) => (opts.peutTrier ?? false) && code === 'feedback:read',
        },
      },
      {
        provide: ActivatedRoute,
        useValue: { queryParams: of(opts.params ?? {}), snapshot: { queryParams: {} } },
      },
    ],
  };
}

function espionnerNavigation(): ReturnType<typeof vi.fn> {
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  return navigate;
}

afterEach(() => vi.restoreAllMocks());

describe('FeedbackListComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement', async () => {
      const list = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(FeedbackListComponent, { providers: setup({ list }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche les retours une fois chargés', async () => {
      await render(FeedbackListComponent, { providers: setup().providers });
      await tick();

      expect(
        await screen.findByRole('heading', { name: /score ne se recalcule pas/ }),
      ).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 retour(s) trouvé(s)');
    });

    it('INVITE à signaler quand il n’y a rien', async () => {
      // « Aucun résultat » ne dit pas quoi faire ensuite.
      await render(FeedbackListComponent, { providers: setup({ items: [], total: 0 }).providers });
      await tick();

      expect(await screen.findByText(/Aucun retour pour l'instant/)).toBeTruthy();
      expect(screen.getByText(/c'est exactement ce qu'on cherche/)).toBeTruthy();
    });

    it('PROPOSE d’effacer les filtres quand ce sont eux qui vident la liste', async () => {
      const t = setup({ items: [], total: 0, params: { statut: 'resolu' } });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/Aucun retour ne correspond/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Effacer les filtres/ })).toBeTruthy();
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      const list = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(FeedbackListComponent, { providers: setup({ list }).providers });
      await tick();

      await userEvent.click(await screen.findByRole('button', { name: /Réessayer/ }));
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  describe('compteurs', () => {
    it('affiche TOUS les statuts, zéros compris', async () => {
      // Masquer ceux à zéro ferait croire qu'ils n'existent pas.
      await render(FeedbackListComponent, { providers: setup().providers });
      await tick();

      for (const nom of ['Nouveau', 'Accepté', 'En cours', 'Résolu', 'Rejeté']) {
        expect(await screen.findByRole('button', { name: new RegExp(nom) })).toBeTruthy();
      }
    });

    it('agit comme un FILTRE, et se retire au second clic', async () => {
      const t = setup({ params: { statut: 'resolu' } });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.click(screen.getByRole('button', { name: /Résolu/ }));
      const params = navigate.mock.calls[0]?.[1] as { queryParams: Record<string, string> };
      expect(params.queryParams['statut']).toBeUndefined();
    });

    it('ANNONCE le compteur actif aux technologies d’assistance', async () => {
      const t = setup({ params: { statut: 'resolu' } });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect(
        (await screen.findByRole('button', { name: /Résolu/ })).getAttribute('aria-pressed'),
      ).toBe('true');
      expect(screen.getByRole('button', { name: /Nouveau/ }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });
  });

  describe('filtres reflétés dans l’URL', () => {
    it('lit les filtres de l’URL et les transmet à l’API', async () => {
      const t = setup({
        params: { statut: 'accepte', type: 'bug', recherche: 'score', page: '2' },
      });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect(t.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        status: 'accepte',
        kind: 'bug',
        search: 'score',
      });
    });

    it('écrit les filtres dans l’URL à la soumission', async () => {
      await render(FeedbackListComponent, { providers: setup().providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.type(screen.getByRole('searchbox', { name: /Recherche/ }), 'export');
      await userEvent.click(screen.getByRole('button', { name: /^Filtrer/ }));

      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { recherche: 'export' } });
    });
  });

  describe('selon les droits', () => {
    it('n’offre PAS « seulement les miens » à qui ne voit déjà que les siens', async () => {
      // La case serait sans effet : l'API restreint déjà.
      await render(FeedbackListComponent, { providers: setup({ peutTrier: false }).providers });
      await tick();

      expect(screen.queryByRole('checkbox', { name: /miens/ })).toBeNull();
    });

    it('l’offre à qui voit tous les retours', async () => {
      await render(FeedbackListComponent, { providers: setup({ peutTrier: true }).providers });
      await tick();

      expect(await screen.findByRole('checkbox', { name: /miens/ })).toBeTruthy();
    });

    it('n’offre AUCUN passage de statut sans feedback:read', async () => {
      await render(FeedbackListComponent, { providers: setup({ peutTrier: false }).providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Marquer/ })).toBeNull();
    });

    it('adapte la phrase d’en-tête au public', async () => {
      await render(FeedbackListComponent, { providers: setup({ peutTrier: false }).providers });
      await tick();
      expect(await screen.findByText(/Ce que vous avez signalé/)).toBeTruthy();
    });
  });

  describe('triage', () => {
    it('n’offre QUE les passages que l’API accepte', async () => {
      // Depuis « nouveau » : accepter ou rejeter, rien d'autre.
      await render(FeedbackListComponent, { providers: setup({ peutTrier: true }).providers });
      await tick();

      expect(await screen.findByRole('button', { name: /Marquer « Accepté »/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Marquer « Rejeté »/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Marquer « Résolu »/ })).toBeNull();
    });

    it('REMPLACE la ligne en place plutôt que de tout recharger', async () => {
      // Recharger ferait sauter l'écran et perdrait le détail ouvert.
      const t = setup({ peutTrier: true });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: /Marquer « Accepté »/ }));
      await tick();

      expect(t.triage).toHaveBeenCalledWith(ID, { status: 'accepte' });
      expect(t.list).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole('button', { name: /Marquer « En cours »/ })).toBeTruthy();
    });

    it('RAFRAÎCHIT les compteurs après un passage', async () => {
      const t = setup({ peutTrier: true });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: /Marquer « Accepté »/ }));
      await tick();

      expect(t.counts).toHaveBeenCalledTimes(2);
    });

    it('DIT que le retour est inchangé quand le passage échoue', async () => {
      const triage = vi.fn().mockRejectedValue(new Error('conflit'));
      const t = setup({ peutTrier: true, triage });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: /Marquer « Accepté »/ }));

      expect(await screen.findByText(/le retour est inchangé/i)).toBeTruthy();
    });

    it('signale un retour SANS passage possible', async () => {
      const bloque = setup({ peutTrier: true, items: [retour({ status: 'archive' as never })] });
      await render(FeedbackListComponent, { providers: bloque.providers });
      await tick();

      expect(await screen.findByText(/Aucun passage possible/)).toBeTruthy();
    });
  });

  describe('lisibilité', () => {
    it('double la couleur du statut par un libellé', async () => {
      const t = setup({ items: [retour({ status: 'resolu' })] });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      const article = (await screen.findByRole('heading', { level: 2 })).closest('article')!;
      expect(within(article).getByText('Résolu')).toBeTruthy();
    });

    it('REPLIE le détail, et l’ouvre sur le retour qu’on vient de déposer', async () => {
      const t = setup({ params: { ouvert: ID } });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect((await screen.findByText('Détail')).closest('details')?.hasAttribute('open')).toBe(
        true,
      );
    });

    it('montre le contexte capturé, sans l’avoir demandé à l’auteur', async () => {
      await render(FeedbackListComponent, { providers: setup().providers });
      await tick();

      await userEvent.click(await screen.findByText('Détail'));
      expect(screen.getByText('/profils/premium')).toBeTruthy();
    });

    it('nomme « compte supprimé » un auteur disparu', async () => {
      // Le retour survit à son auteur ; l'afficher sans nom le rendrait
      // incompréhensible.
      const t = setup({ items: [retour({ authorId: null, authorName: null })] });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/compte supprimé/)).toBeTruthy();
    });

    it('affiche la réponse rendue à l’auteur', async () => {
      const t = setup({ items: [retour({ status: 'resolu', resolution: 'Corrigé en 2.0.1.' })] });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText('Corrigé en 2.0.1.')).toBeTruthy();
    });
  });

  describe('lecture seule du dossier', () => {
    it('n’offre NI suppression NI réécriture', async () => {
      // L'API n'en offre pas ; le proposer donnerait une fausse idée de ce qui
      // est garanti à celui qui dépose un retour.
      await render(FeedbackListComponent, { providers: setup({ peutTrier: true }).providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Supprimer|Modifier le titre/ })).toBeNull();
    });
  });

  describe('pagination', () => {
    it('ne s’affiche pas sur une page unique', async () => {
      await render(FeedbackListComponent, { providers: setup({ total: 10 }).providers });
      await tick();

      expect(screen.queryByRole('navigation', { name: /Pagination/ })).toBeNull();
    });

    it('navigue de page en page', async () => {
      const t = setup({ total: 60, params: { page: '2' } });
      await render(FeedbackListComponent, { providers: t.providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.click(screen.getByRole('button', { name: /Page suivante/ }));
      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { page: '3' } });
    });
  });
});
