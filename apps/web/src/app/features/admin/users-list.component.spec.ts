import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { of } from 'rxjs';
import { RANKS, type CurrentUser, type UserSummary } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';
import { UsersListComponent } from './users-list.component';

const ID_MOI = '11111111-1111-4111-8111-111111111111';
const ID_AUTRE = '22222222-2222-4222-8222-222222222222';

function compte(over: Partial<UserSummary> = {}): UserSummary {
  return {
    id: ID_AUTRE,
    username: 'bob',
    displayName: null,
    email: null,
    rank: RANKS.TESTER,
    role: 'tester',
    status: 'active',
    lockedUntil: null,
    totalScansLaunched: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function moi(over: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: ID_MOI,
    username: 'alice',
    rank: RANKS.ADMIN,
    role: 'admin',
    status: 'active',
    permissions: [],
    ...over,
  };
}

/** Laisse le micro-ordonnanceur vider sa file — le chargement est asynchrone. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    users?: UserSummary[];
    total?: number;
    list?: ReturnType<typeof vi.fn>;
    params?: Record<string, string>;
    utilisateur?: CurrentUser;
    permissions?: string[];
  } = {},
) {
  const list =
    opts.list ??
    vi.fn().mockResolvedValue({
      users: opts.users ?? [compte()],
      total: opts.total ?? opts.users?.length ?? 1,
    });

  const utilisateur = opts.utilisateur ?? moi();
  const permissions = opts.permissions ?? ['users:write'];

  return {
    list,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: UsersApi, useValue: { list } },
      {
        provide: AuthService,
        useValue: {
          user: () => utilisateur,
          hasPermission: (code: string) => permissions.includes(code),
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
  const router = TestBed.inject(Router);
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(router, 'navigate').mockImplementation(navigate);
  return navigate;
}

afterEach(() => vi.restoreAllMocks());

describe('UsersListComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement avant l’arrivée des données', async () => {
      const list = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(UsersListComponent, { providers: setup({ list }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche les comptes une fois chargés', async () => {
      await render(UsersListComponent, { providers: setup().providers });
      await tick();

      expect(await screen.findByRole('rowheader', { name: /bob/ })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 compte(s) trouvé(s)');
    });

    it('GUIDE l’utilisateur quand il n’y a aucun compte', async () => {
      // « Aucun résultat » ne dit pas quoi faire ensuite.
      await render(UsersListComponent, { providers: setup({ users: [], total: 0 }).providers });
      await tick();

      expect(await screen.findByText(/Aucun compte pour l'instant/)).toBeTruthy();
      expect(screen.getByText(/Créez un premier compte/)).toBeTruthy();
    });

    it('PROPOSE d’effacer les filtres quand ce sont eux qui vident la liste', async () => {
      const t = setup({ users: [], total: 0, params: { recherche: 'introuvable' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/Aucun compte ne correspond à ces filtres/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Effacer les filtres/ })).toBeTruthy();
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      const list = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(UsersListComponent, { providers: setup({ list }).providers });
      await tick();

      expect(await screen.findByRole('alert')).toBeTruthy();
      const reprise = screen.getByRole('button', { name: /Réessayer/ });
      await userEvent.click(reprise);
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  describe('filtres reflétés dans l’URL', () => {
    it('lit les filtres de l’URL et les transmet à l’API', async () => {
      const t = setup({ params: { recherche: 'ali', rang: '50', statut: 'suspended', page: '2' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(t.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        search: 'ali',
        rank: RANKS.ADMIN,
        status: 'suspended',
      });
    });

    it('PRÉ-REMPLIT les champs depuis l’URL', async () => {
      // Sinon un lien partagé afficherait des résultats filtrés sous des
      // champs vides, et l'utilisateur ne saurait pas ce qui est appliqué.
      const t = setup({ params: { recherche: 'ali', statut: 'active' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      // `ngModel` écrit la PROPRIÉTÉ `value`, pas l'attribut : lire l'attribut
      // rendrait `null` quelle que soit la valeur affichée.
      const recherche = await screen.findByRole<HTMLInputElement>('searchbox', {
        name: /Recherche/,
      });
      expect(recherche.value).toBe('ali');
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: /Statut/ }).value).toBe(
        'active',
      );
    });

    it('écrit les filtres dans l’URL à la soumission', async () => {
      await render(UsersListComponent, { providers: setup().providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.type(screen.getByRole('searchbox', { name: /Recherche/ }), 'bob');
      await userEvent.click(screen.getByRole('button', { name: /^Filtrer/ }));

      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { recherche: 'bob' } });
    });

    it('RAMÈNE en page 1 dès qu’un filtre change', async () => {
      // Rester page 4 afficherait un extrait arbitraire d'un résultat qui n'a
      // plus rien à voir.
      const t = setup({ params: { page: '4' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.type(screen.getByRole('searchbox', { name: /Recherche/ }), 'x');
      await userEvent.click(screen.getByRole('button', { name: /^Filtrer/ }));

      const params = navigate.mock.calls[0]?.[1] as { queryParams: Record<string, string> };
      expect(params.queryParams['page']).toBeUndefined();
    });

    it('n’offre PAS « Réinitialiser » sans filtre posé', async () => {
      await render(UsersListComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Réinitialiser/ })).toBeNull();
    });

    it('offre « Réinitialiser » dès qu’un filtre est posé', async () => {
      // Deux tests plutôt qu'un : `TestBed` ne se configure qu'une fois par
      // test, un second `render` dans le même corps échoue.
      const t = setup({ params: { statut: 'active' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(screen.getByRole('button', { name: /Réinitialiser/ })).toBeTruthy();
    });
  });

  describe('anticipation des garde-fous', () => {
    it('propose « Modifier » sur un compte de rang inférieur', async () => {
      await render(UsersListComponent, { providers: setup().providers });
      await tick();

      expect(await screen.findByRole('link', { name: /Ouvrir la fiche de bob/ })).toBeTruthy();
    });

    it('n’offre PAS de modifier son propre compte, et dit pourquoi', async () => {
      const t = setup({ users: [compte({ id: ID_MOI, username: 'alice', rank: RANKS.ADMIN })] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(screen.queryByRole('link', { name: /Ouvrir la fiche/ })).toBeNull();
      expect(await screen.findByText(/propre rang/)).toBeTruthy();
    });

    it('n’offre PAS d’agir sur un rang supérieur, et dit pourquoi', async () => {
      const t = setup({ users: [compte({ rank: RANKS.SUPER_ADMIN, username: 'patron' })] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(screen.queryByRole('link', { name: /Ouvrir la fiche/ })).toBeNull();
      expect(await screen.findByText(/rang supérieur ou égal/)).toBeTruthy();
    });

    it('SIGNALE la lecture seule quand users:write manque', async () => {
      const t = setup({ permissions: [] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(screen.queryByRole('link', { name: /Créer un compte/ })).toBeNull();
      expect(await screen.findByText(/Lecture seule/)).toBeTruthy();
    });

    it('marque le compte de l’utilisateur courant', async () => {
      const t = setup({ users: [compte({ id: ID_MOI, username: 'alice', rank: RANKS.ADMIN })] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      const ligne = await screen.findByRole('rowheader', { name: /alice/ });
      expect(within(ligne).getByText('vous')).toBeTruthy();
    });
  });

  describe('lisibilité du tableau', () => {
    it('double la couleur du statut par un libellé', async () => {
      // La couleur seule est invisible pour un lecteur d'écran et ambiguë en
      // cas de daltonisme.
      const t = setup({ users: [compte({ status: 'suspended' })] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      // « Suspendu » figure aussi dans le filtre déroulant : on interroge la
      // cellule, pas la page entière.
      const tableau = await screen.findByRole('table');
      expect(within(tableau).getByText('Suspendu')).toBeTruthy();
    });

    it('signale un verrou temporaire', async () => {
      const t = setup({ users: [compte({ lockedUntil: '2026-03-01T10:00:00.000Z' })] });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/verrouillé jusqu'au/)).toBeTruthy();
    });

    it('décrit le tableau pour les lecteurs d’écran', async () => {
      const t = setup({ total: 42 });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      const tableau = await screen.findByRole('table');
      expect(tableau.querySelector('caption')?.textContent).toContain('42');
    });
  });

  describe('pagination', () => {
    it('ne s’affiche pas sur une page unique', async () => {
      await render(UsersListComponent, { providers: setup({ total: 10 }).providers });
      await tick();

      expect(screen.queryByRole('navigation', { name: /Pagination/ })).toBeNull();
    });

    it('navigue de page en page', async () => {
      const t = setup({ total: 60, params: { page: '2' } });
      await render(UsersListComponent, { providers: t.providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.click(screen.getByRole('button', { name: /Page suivante/ }));
      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { page: '3' } });
    });

    it('désactive les bords de la pagination', async () => {
      const t = setup({ total: 60 });
      await render(UsersListComponent, { providers: t.providers });
      await tick();

      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: /Page précédente/ }).disabled,
      ).toBe(true);
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: /Page suivante/ }).disabled,
      ).toBe(false);
    });
  });
});
