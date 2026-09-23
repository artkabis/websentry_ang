import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { of } from 'rxjs';
import type { UsageGovernance, UsageOverview } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageApi } from '../../core/usage/usage.api';
import { UsageDashboardComponent } from './usage-dashboard.component';

function apercu(over: Partial<UsageOverview> = {}): UsageOverview {
  return {
    periode: '30j',
    depuis: '2026-03-01T12:00:00.000Z',
    jusqua: '2026-03-31T12:00:00.000Z',
    comptesActifs: 10,
    tunnel: [
      { cle: 'connexion', comptes: 10, actions: 50 },
      { cle: 'analyse', comptes: 6, actions: 120 },
      { cle: 'exploitation', comptes: 3, actions: 9 },
    ],
    parJour: [
      { jour: '2026-03-29', connexions: 2, analyses: 5 },
      { jour: '2026-03-30', connexions: 4, analyses: 30 },
      { jour: '2026-03-31', connexions: 1, analyses: 0 },
    ],
    gammes: [
      { gamme: 'premium', analyses: 80, scoreMoyen: 72.46 },
      { gamme: 'standard', analyses: 3, scoreMoyen: null },
    ],
    ...over,
  };
}

function registre(over: Partial<UsageGovernance> = {}): UsageGovernance {
  return {
    sources: [
      {
        table: 'audit_log',
        finalite: 'Tracer les actions sensibles',
        donnees: ['identifiant de compte', 'adresse IP'],
        retentionJours: 180,
      },
      {
        table: 'users',
        finalite: 'Authentifier et autoriser',
        donnees: ['identifiant'],
        retentionJours: null,
      },
    ],
    anonymisation: { apresJours: 180, anonymisees: 1200, enAttente: 0, dernierPassage: null },
    collecteDediee: false,
    ...over,
  };
}

/**
 * Laisse l'écran se poser.
 *
 * Deux tours et non un : le premier rend la main aux promesses du double, le
 * second laisse la détection de changements sans zone appliquer les signaux
 * qu'elles viennent d'écrire. Avec un seul, on interroge un écran encore en
 * chargement — et le test échoue pour une raison qui n'a rien à voir avec ce
 * qu'il vérifie.
 */
const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

function setup(
  opts: {
    overview?: ReturnType<typeof vi.fn>;
    governance?: ReturnType<typeof vi.fn>;
    vue?: UsageOverview;
    gouvernance?: UsageGovernance;
    params?: Record<string, string>;
  } = {},
) {
  const overview = opts.overview ?? vi.fn().mockResolvedValue(opts.vue ?? apercu());
  const governance = opts.governance ?? vi.fn().mockResolvedValue(opts.gouvernance ?? registre());

  return {
    overview,
    governance,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: UsageApi, useValue: { overview, governance } },
      {
        provide: ActivatedRoute,
        useValue: { queryParams: of(opts.params ?? {}), snapshot: { queryParams: {} } },
      },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('UsageDashboardComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement', async () => {
      const overview = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(UsageDashboardComponent, { providers: setup({ overview }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche le tunnel une fois chargé', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(await screen.findByRole('heading', { name: "Tunnel d'usage" })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('10 compte(s) actif(s)');
    });

    it('EXPLIQUE une période sans activité', async () => {
      // « Aucun résultat » ne dit pas quoi faire ni quoi attendre.
      await render(UsageDashboardComponent, {
        providers: setup({ vue: apercu({ comptesActifs: 0 }) }).providers,
      });
      await tick();

      // L'annonce vocale et la carte ne disent PAS la même phrase : la
      // répéter mot pour mot la ferait entendre deux fois.
      expect(screen.getByRole('status').textContent).toContain('Aucune activité');
      expect(screen.getByText(/Rien à mesurer pour l'instant/)).toBeTruthy();
      expect(screen.getByText(/fenêtre plus large/)).toBeTruthy();
    });

    it('PROPOSE une reprise quand le chargement échoue', async () => {
      const overview = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(UsageDashboardComponent, { providers: setup({ overview }).providers });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('Impossible de charger');
      expect(within(alerte).getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    });
  });

  describe('tunnel', () => {
    it('rapporte chaque étape à l’ENTRÉE', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByLabelText('100 % des comptes entrés')).toBeTruthy();
      expect(screen.getByLabelText('60 % des comptes entrés')).toBeTruthy();
      expect(screen.getByLabelText('30 % des comptes entrés')).toBeTruthy();
    });

    it('DOUBLE la barre par un chiffre lisible', async () => {
      // Une proportion lue seulement à la longueur d'un trait n'est pas
      // lisible pour tout le monde.
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      const analyse = screen.getByRole('heading', { name: 'Lancent une analyse' }).closest('li')!;
      expect(analyse.textContent).toContain('6');
      expect(analyse.textContent).toContain('120 action(s)');
    });

    it('APPLIQUE le seuil d’anonymat à l’affichage', async () => {
      // Un « 2 » désignerait quelqu'un dans une équipe de dix.
      await render(UsageDashboardComponent, {
        providers: setup({
          vue: apercu({
            tunnel: [
              { cle: 'connexion', comptes: 10, actions: 50 },
              { cle: 'analyse', comptes: 2, actions: 4 },
              { cle: 'exploitation', comptes: 0, actions: 0 },
            ],
          }),
        }).providers,
      });
      await tick();

      const analyse = screen.getByRole('heading', { name: 'Lancent une analyse' }).closest('li')!;
      expect(analyse.textContent).toContain('moins de 5');
      expect(analyse.textContent).not.toMatch(/\b2 compte/);
    });

    it('DIT ce que chaque étape prouve', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByText(/ont lancé au moins un scan/)).toBeTruthy();
    });
  });

  describe('courbe', () => {
    it('porte un LIBELLÉ, puisque c’est une image', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      const graphe = screen.getByRole('img', { name: /connexion\(s\) et .* analyse\(s\)/ });
      expect(graphe).toBeTruthy();
    });

    it('DOUBLE le graphe par un tableau de chiffres', async () => {
      // Le résumé donne le survol ; le tableau donne les nombres.
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      const tableau = screen.getByRole('table', { name: /jour par jour/ });
      expect(within(tableau).getByRole('rowheader', { name: '30/03' })).toBeTruthy();
      expect(within(tableau).getAllByRole('row')).toHaveLength(4);
    });
  });

  describe('gammes', () => {
    it('distingue un score ABSENT d’un score nul', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      const tableau = screen.getByRole('table', { name: /par gamme/ });
      expect(within(tableau).getByText('non mesuré')).toBeTruthy();
      expect(within(tableau).getByText('72.5')).toBeTruthy();
    });

    it('n’affiche PAS la section sans aucune gamme', async () => {
      await render(UsageDashboardComponent, {
        providers: setup({ vue: apercu({ gammes: [] }) }).providers,
      });
      await tick();

      expect(screen.queryByRole('heading', { name: 'Par gamme' })).toBeNull();
    });
  });

  describe('registre de traitement', () => {
    it('ANNONCE qu’aucune collecte dédiée n’existe', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByText(/Aucune collecte dédiée/)).toBeTruthy();
    });

    it('DIT quand une table n’est pas purgée', async () => {
      // Le taire laisserait croire à une purge qui n'existe pas.
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByText('Aucune purge automatique')).toBeTruthy();
      expect(screen.getByText('180 jours')).toBeTruthy();
    });

    it('annonce l’ABSENCE de passage plutôt qu’un vide', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByText('aucun depuis le démarrage')).toBeTruthy();
    });

    it('SIGNALE un retard d’anonymisation', async () => {
      await render(UsageDashboardComponent, {
        providers: setup({
          gouvernance: registre({
            anonymisation: {
              apresJours: 180,
              anonymisees: 100,
              enAttente: 37,
              dernierPassage: '2026-03-30T03:00:00.000Z',
            },
          }),
        }).providers,
      });
      await tick();

      const enAttente = screen.getByText('37');
      expect(enAttente.className).toContain('warn');
    });

    it('reste affiché même quand l’aperçu est VIDE', async () => {
      // Ce que l'application conserve ne dépend pas de l'activité du mois.
      await render(UsageDashboardComponent, {
        providers: setup({ vue: apercu({ comptesActifs: 0 }) }).providers,
      });
      await tick();

      expect(screen.getByRole('heading', { name: /Ce que l'application conserve/ })).toBeTruthy();
    });
  });

  describe('période', () => {
    it('LIT la période de l’URL', async () => {
      const t = setup({ params: { periode: '7j' } });
      await render(UsageDashboardComponent, { providers: t.providers });
      await tick();

      expect(t.overview).toHaveBeenCalledWith('7j');
    });

    it('ÉCRIT la période dans l’URL, donc la rend partageable', async () => {
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();
      const navigate = vi.fn().mockResolvedValue(true);
      vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);

      await userEvent.click(screen.getByRole('radio', { name: '7 derniers jours' }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { periode: '7j' } }),
      );
    });

    it('n’offre QUE les trois fenêtres du catalogue', async () => {
      // Une plage libre laisserait isoler une heure, et un compteur sur une
      // heure dans une équipe de dix désigne quelqu'un.
      await render(UsageDashboardComponent, { providers: setup().providers });
      await tick();

      expect(screen.getAllByRole('radio')).toHaveLength(3);
    });
  });
});
