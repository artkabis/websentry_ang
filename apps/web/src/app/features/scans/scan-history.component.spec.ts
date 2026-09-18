import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { BehaviorSubject, of } from 'rxjs';
import type { SiteSummary } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScansApi } from '../../core/scans/scans.api';
import { ScanHistoryComponent } from './scan-history.component';

function site(over: Partial<SiteSummary> = {}): SiteSummary {
  return {
    siteId: '44444444-4444-4444-8444-444444444444',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: 'ABC-123',
    lastSessionId: '11111111-1111-4111-8111-111111111111',
    pageCount: 12,
    avgScore: 4.2,
    minScore: 3,
    maxScore: 5,
    lastScan: '2026-06-04T10:00:00.000Z',
    sessionCount: 3,
    launchedBy: 'alice',
    metadata: null,
    ...over,
  };
}

/** Laisse le micro-ordonnanceur vider sa file — le chargement est asynchrone. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    sites?: SiteSummary[];
    total?: number;
    pages?: number;
    listSites?: ReturnType<typeof vi.fn>;
    params?: Record<string, string>;
  } = {},
) {
  const listSites =
    opts.listSites ??
    vi.fn().mockResolvedValue({
      total: opts.total ?? opts.sites?.length ?? 1,
      page: 1,
      limit: 20,
      pages: opts.pages ?? 1,
      sites: opts.sites ?? [site()],
    });

  return {
    listSites,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ScansApi, useValue: { listSites } },
      {
        provide: ActivatedRoute,
        useValue: { queryParams: of(opts.params ?? {}), snapshot: { queryParams: {} } },
      },
    ],
  };
}

function spyOnNavigate(): ReturnType<typeof vi.fn> {
  const router = TestBed.inject(Router);
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(router, 'navigate').mockImplementation(navigate);
  return navigate;
}

afterEach(() => vi.restoreAllMocks());

describe('ScanHistoryComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement avant l’arrivée des données', async () => {
      const listSites = vi.fn().mockReturnValue(new Promise(() => undefined));
      const t = setup({ listSites });
      await render(ScanHistoryComponent, { providers: t.providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche les sites une fois chargés', async () => {
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByRole('link', { name: /exemple\.fr/ })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 site(s) trouvé(s)');
    });

    it('GUIDE l’utilisateur quand l’historique est vide', async () => {
      // « Aucun résultat » ne dit pas quoi faire ensuite.
      const t = setup({ sites: [], total: 0, pages: 0 });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/L'historique est vide/)).toBeTruthy();
      expect(screen.getByText(/dès le premier scan enregistré/)).toBeTruthy();
    });

    it('PROPOSE d’effacer les filtres quand ce sont eux qui vident la liste', async () => {
      const t = setup({ sites: [], total: 0, pages: 0, params: { domain: 'introuvable' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/Aucun site ne correspond à ces filtres/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Effacer les filtres/ })).toBeTruthy();
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      // Un message d'erreur sans action laisse l'utilisateur sans recours.
      const listSites = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ listSites });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Impossible de charger');

      await userEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
      expect(listSites).toHaveBeenCalledTimes(2);
    });
  });

  describe('lecture de l’URL', () => {
    it('APPLIQUE les filtres présents dans l’adresse', async () => {
      // Une recherche partagée doit produire le même résultat chez le
      // destinataire.
      const t = setup({ params: { domain: 'exemple.fr', gamme: 'premium', page: '2' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(t.listSites).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'exemple.fr', gamme: 'premium', page: 2 }),
      );
    });

    it('pré-remplit les champs depuis l’URL', async () => {
      const t = setup({ params: { q: 'exemple', gamme: 'premium' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect((await screen.findByLabelText<HTMLInputElement>(/Recherche/)).value).toBe('exemple');
      expect(screen.getByLabelText<HTMLInputElement>(/^Gamme$/).value).toBe('premium');
    });

    it('RECHARGE quand l’URL change sans reconstruire le composant', async () => {
      // C'est le cas du bouton « Précédent » du navigateur : sans réaction au
      // changement de paramètres, l'écran afficherait le résultat de la
      // recherche précédente sous une adresse qui en annonce une autre.
      const params = new BehaviorSubject<Record<string, string>>({ domain: 'premier.fr' });
      const listSites = vi
        .fn()
        .mockResolvedValue({ total: 0, page: 1, limit: 20, pages: 0, sites: [] });

      await render(ScanHistoryComponent, {
        providers: [
          provideZonelessChangeDetection(),
          provideRouter([]),
          { provide: ScansApi, useValue: { listSites } },
          { provide: ActivatedRoute, useValue: { queryParams: params, snapshot: {} } },
        ],
      });
      await tick();

      params.next({ domain: 'second.fr' });
      await tick();

      expect(listSites).toHaveBeenCalledTimes(2);
      expect(listSites).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'second.fr' }));
    });

    it('ÉCRIT les filtres dans l’URL plutôt que dans son état interne', async () => {
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();
      const navigate = spyOnNavigate();

      await userEvent.type(screen.getByLabelText(/Recherche/), 'exemple');
      await userEvent.click(screen.getByRole('button', { name: 'Filtrer' }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: expect.objectContaining({ q: 'exemple' }) }),
      );
    });

    it('REMPLACE les paramètres au lieu de les fusionner', async () => {
      // Sans quoi un filtre effacé resterait dans l'URL et continuerait de
      // s'appliquer.
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();
      const navigate = spyOnNavigate();

      await userEvent.click(screen.getByRole('button', { name: 'Filtrer' }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParamsHandling: 'replace' }),
      );
    });
  });

  describe('tri', () => {
    it('annonce le sens du tri aux technologies d’assistance', async () => {
      const t = setup({ params: { sort: 'score', order: 'asc' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      const header = await screen.findByRole('columnheader', { name: /Score moyen/ });
      expect(header.getAttribute('aria-sort')).toBe('ascending');
    });

    it('n’annonce aucun tri sur les autres colonnes', async () => {
      const t = setup({ params: { sort: 'score' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      const header = await screen.findByRole('columnheader', { name: /Domaine/ });
      expect(header.getAttribute('aria-sort')).toBe('none');
    });

    it('trie par clic sur l’en-tête', async () => {
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();
      const navigate = spyOnNavigate();

      await userEvent.click(screen.getByRole('button', { name: /Score moyen/ }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: expect.objectContaining({ sort: 'score' }) }),
      );
    });
  });

  describe('accessibilité', () => {
    it('DOUBLE la couleur du score par un libellé textuel', async () => {
      // La couleur est invisible pour un lecteur d'écran et ambiguë en cas de
      // daltonisme.
      const t = setup({ sites: [site({ avgScore: 1.5 })] });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      const row = (await screen.findAllByRole('row'))[1]!;
      expect(within(row).getByText(/critique/)).toBeTruthy();
    });

    it('résume la ligne pour le lecteur d’écran', async () => {
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      const link = await screen.findByRole('link', { name: /exemple\.fr, gamme premium/ });
      expect(link.getAttribute('aria-label')).toContain('12 page(s)');
    });

    it('nomme explicitement un site sans gamme', async () => {
      const t = setup({ sites: [site({ gamme: null })] });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText('sans gamme')).toBeTruthy();
    });
  });

  describe('validation avant appel', () => {
    it('BLOQUE la soumission sur un intervalle de dates inversé', async () => {
      // Le backend refuserait en 400 ; le dire ici évite l'aller-retour.
      const t = setup();
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      await userEvent.type(screen.getByLabelText(/Analysé depuis le/), '2026-06-30');
      await userEvent.type(screen.getByLabelText(/Jusqu'au/), '2026-06-01');

      expect((await screen.findByRole('alert')).textContent).toContain('date de début');
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Filtrer' }).disabled).toBe(
        true,
      );
    });
  });

  describe('pagination', () => {
    it('n’affiche pas la pagination sur une page unique', async () => {
      const t = setup({ pages: 1 });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    });

    it('navigue de page en page', async () => {
      const t = setup({ pages: 3, params: { page: '2' } });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();
      const navigate = spyOnNavigate();

      await userEvent.click(screen.getByRole('button', { name: 'Page suivante' }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: expect.objectContaining({ page: '3' }) }),
      );
    });

    it('désactive « précédent » sur la première page', async () => {
      const t = setup({ pages: 3 });
      await render(ScanHistoryComponent, { providers: t.providers });
      await tick();

      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Page précédente' }).disabled,
      ).toBe(true);
    });
  });
});
