import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { RANKS, type CurrentUser, type UserSummary } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';
import { UserEditorComponent } from './user-editor.component';

const ID_MOI = '11111111-1111-4111-8111-111111111111';
const ID_CIBLE = '22222222-2222-4222-8222-222222222222';

function compte(over: Partial<UserSummary> = {}): UserSummary {
  return {
    id: ID_CIBLE,
    username: 'bob',
    displayName: 'Bob Martin',
    email: 'bob@exemple.fr',
    rank: RANKS.TESTER,
    role: 'tester',
    status: 'active',
    lockedUntil: null,
    totalScansLaunched: 0,
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

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    compte?: UserSummary;
    get?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    resetPassword?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
    utilisateur?: CurrentUser;
    permissions?: string[];
  } = {},
) {
  const cible = opts.compte ?? compte();
  const api = {
    get: opts.get ?? vi.fn().mockResolvedValue(cible),
    create: opts.create ?? vi.fn().mockResolvedValue(compte({ id: ID_CIBLE })),
    update:
      opts.update ??
      vi.fn().mockImplementation((_id, diff) => Promise.resolve({ ...cible, ...diff })),
    resetPassword: opts.resetPassword ?? vi.fn().mockResolvedValue(undefined),
    remove: opts.remove ?? vi.fn().mockResolvedValue(undefined),
    listPermissions: vi.fn().mockResolvedValue([]),
    grantPermission: vi.fn().mockResolvedValue(undefined),
    revokePermission: vi.fn().mockResolvedValue(undefined),
  };

  const utilisateur = opts.utilisateur ?? moi();
  const permissions = opts.permissions ?? ['users:write', 'users:delete'];

  return {
    api,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: UsersApi, useValue: api },
      {
        provide: AuthService,
        useValue: {
          user: () => utilisateur,
          rank: () => utilisateur.rank,
          hasPermission: (code: string) => permissions.includes(code),
        },
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

describe('UserEditorComponent — création', () => {
  it('demande identifiant et mot de passe, qui ne servent qu’ici', async () => {
    await render(UserEditorComponent, { providers: setup().providers });
    await tick();

    expect(await screen.findByRole('textbox', { name: /Identifiant/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Nouveau compte/ })).toBeTruthy();
  });

  it('n’offre NI mot de passe NI suppression tant que le compte n’existe pas', async () => {
    await render(UserEditorComponent, { providers: setup().providers });
    await tick();

    expect(screen.queryByRole('heading', { name: /Réinitialiser/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Supprimer…/ })).toBeNull();
  });

  it('GARDE la création désactivée tant que le brouillon est invalide', async () => {
    await render(UserEditorComponent, { providers: setup().providers });
    await tick();

    const creer = screen.getByRole<HTMLButtonElement>('button', { name: /Créer le compte/ });
    expect(creer.disabled).toBe(true);
  });

  it('génère un mot de passe conforme, et l’affiche en clair', async () => {
    // Il faut pouvoir le transmettre : masqué, il serait illisible pour qui
    // doit le communiquer, et il n'est plus jamais affiché ensuite.
    await render(UserEditorComponent, { providers: setup().providers });
    await tick();

    await userEvent.click(screen.getByRole('button', { name: /Générer/ }));
    const champ = screen.getByRole<HTMLInputElement>('textbox', { name: /Mot de passe/ });
    expect(champ.value.length).toBeGreaterThanOrEqual(12);
    expect(champ.getAttribute('type')).toBe('text');
  });

  it('crée le compte puis ouvre sa fiche', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers });
    await tick();
    const navigate = espionnerNavigation();

    await userEvent.type(screen.getByRole('textbox', { name: /Identifiant/ }), 'nouvelle.recrue');
    await userEvent.click(screen.getByRole('button', { name: /Générer/ }));
    // `[ngValue]` encode l'option : on la désigne par son libellé, comme le
    // ferait une personne devant l'écran.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Rang/ }),
      screen.getByRole('option', { name: 'Testeur' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Créer le compte/ }));
    await tick();

    expect(t.api.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'nouvelle.recrue', rank: RANKS.TESTER }),
    );
    expect(navigate).toHaveBeenCalledWith(['/administration/comptes', ID_CIBLE]);
  });

  it('n’offre QUE les rangs inférieurs au sien', async () => {
    await render(UserEditorComponent, { providers: setup().providers });
    await tick();

    const rang = await screen.findByRole('combobox', { name: /Rang/ });
    const options = within(rang)
      .getAllByRole('option')
      .map(o => o.textContent?.trim());
    expect(options).toEqual(['Choisir…', 'Testeur', 'Éditeur']);
  });

  it('laisse le super_admin attribuer tous les rangs', async () => {
    const t = setup({ utilisateur: moi({ rank: RANKS.SUPER_ADMIN, role: 'super_admin' }) });
    await render(UserEditorComponent, { providers: t.providers });
    await tick();

    const rang = await screen.findByRole('combobox', { name: /Rang/ });
    expect(within(rang).getAllByRole('option')).toHaveLength(5);
  });
});

describe('UserEditorComponent — édition', () => {
  it('charge la fiche et pré-remplit les champs', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    expect(t.api.get).toHaveBeenCalledWith(ID_CIBLE);
    const nom = await screen.findByRole<HTMLInputElement>('textbox', { name: /Nom affiché/ });
    expect(nom.value).toBe('Bob Martin');
  });

  it('n’offre PAS de changer l’identifiant', async () => {
    await render(UserEditorComponent, { providers: setup().providers, inputs: { id: ID_CIBLE } });
    await tick();

    expect(screen.queryByRole('textbox', { name: /Identifiant/ })).toBeNull();
    expect(await screen.findByText(/Identifiant :/)).toBeTruthy();
  });

  it('DÉSACTIVE l’enregistrement tant que rien n’a changé, et le dit', async () => {
    await render(UserEditorComponent, { providers: setup().providers, inputs: { id: ID_CIBLE } });
    await tick();

    const enregistrer = await screen.findByRole<HTMLButtonElement>('button', {
      name: /Enregistrer/,
    });
    expect(enregistrer.disabled).toBe(true);
    expect(screen.getByText(/Aucune modification à enregistrer/)).toBeTruthy();
  });

  it('n’envoie QUE le champ modifié', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Statut/ }), ['suspended']);
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
    await tick();

    expect(t.api.update).toHaveBeenCalledWith(ID_CIBLE, { status: 'suspended' });
  });

  it('AVERTIT avant l’appel réseau quand le courriel est invalide', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    const courriel = await screen.findByRole('textbox', { name: /Courriel/ });
    await userEvent.clear(courriel);
    await userEvent.type(courriel, 'pas-un-courriel');

    expect(await screen.findByText(/^Courriel /)).toBeTruthy();
    expect(t.api.update).not.toHaveBeenCalled();
  });

  it('REPREND le message précis de l’API plutôt qu’un échec générique', async () => {
    // « C'est le dernier compte d'administration actif » ne peut pas être
    // reconstitué côté client : l'interface ignore combien il en reste.
    const update = vi.fn().mockRejectedValue({
      error: { message: 'C’est le dernier compte d’administration actif.' },
    });
    const t = setup({ update });
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });

    const statut = await screen.findByRole('combobox', { name: /Statut/ });
    await userEvent.selectOptions(statut, ['suspended']);
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByText(/dernier compte d’administration actif/)).toBeTruthy();
  });

  it('annonce un compte introuvable plutôt qu’un écran vide', async () => {
    const get = vi.fn().mockRejectedValue(new Error('404'));
    await render(UserEditorComponent, {
      providers: setup({ get }).providers,
      inputs: { id: ID_CIBLE },
    });
    await tick();

    expect(await screen.findByText(/Ce compte n'existe pas ou plus/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Revenir à la liste/ })).toBeTruthy();
  });
});

describe('UserEditorComponent — mot de passe', () => {
  it('exige la confirmation, et refuse deux saisies divergentes', async () => {
    await render(UserEditorComponent, { providers: setup().providers, inputs: { id: ID_CIBLE } });
    await tick();

    const champs = await screen.findAllByRole('textbox', { name: /mot de passe|Confirmation/i });
    const nouveau = screen.getByRole('textbox', { name: /Nouveau mot de passe/ });
    const confirmation = screen.getByRole('textbox', { name: /Confirmation/ });
    expect(champs.length).toBeGreaterThan(0);

    await userEvent.type(nouveau, 'MotDePasseValide!2026');
    await userEvent.type(confirmation, 'autre chose');

    expect(await screen.findByText(/Les deux saisies diffèrent/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /^Réinitialiser$/ }).disabled,
    ).toBe(true);
  });

  it('réinitialise et prévient que le secret ne sera plus affiché', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    await userEvent.click(
      within(
        screen.getByRole('heading', { name: /Réinitialiser le mot de passe/ }).parentElement!,
      ).getByRole('button', { name: /Générer/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Réinitialiser$/ }));
    await tick();

    expect(t.api.resetPassword).toHaveBeenCalled();
    expect(await screen.findByText(/Transmettez-le maintenant/)).toBeTruthy();
  });
});

describe('UserEditorComponent — suppression', () => {
  it('CONFIRME avant de supprimer, en nommant le compte', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    await userEvent.click(await screen.findByRole('button', { name: /Supprimer…/ }));
    expect(await screen.findByText(/Supprimer définitivement/)).toBeTruthy();
    expect(t.api.remove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Oui, supprimer/ }));
    await tick();
    expect(t.api.remove).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('laisse revenir en arrière sans rien supprimer', async () => {
    const t = setup();
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    await userEvent.click(await screen.findByRole('button', { name: /Supprimer…/ }));
    await userEvent.click(screen.getByRole('button', { name: /Annuler/ }));

    expect(screen.queryByText(/Supprimer définitivement/)).toBeNull();
    expect(t.api.remove).not.toHaveBeenCalled();
  });

  it('n’offre PAS la suppression sans users:delete', async () => {
    const t = setup({ permissions: ['users:write'] });
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    expect(screen.queryByRole('button', { name: /Supprimer…/ })).toBeNull();
  });
});

describe('UserEditorComponent — garde-fous anticipés', () => {
  it('EXPLIQUE le refus sur un compte de rang supérieur, atteint par son adresse', async () => {
    const t = setup({ compte: compte({ rank: RANKS.SUPER_ADMIN, username: 'patron' }) });
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_CIBLE } });
    await tick();

    // La phrase d'aide du champ « Rang » contient la même tournure : on vise
    // le bandeau de refus, reconnaissable à sa seconde phrase.
    expect(
      await screen.findByText(/Vous pouvez consulter cette fiche, pas la modifier/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Supprimer…/ })).toBeNull();
  });

  it('interdit de modifier son propre rang, mais PAS son mot de passe', async () => {
    const t = setup({ compte: compte({ id: ID_MOI, username: 'alice', rank: RANKS.ADMIN }) });
    await render(UserEditorComponent, { providers: t.providers, inputs: { id: ID_MOI } });
    await tick();

    expect(
      await screen.findByText(/Vous pouvez consulter cette fiche, pas la modifier/),
    ).toBeTruthy();
    // Le formulaire de mot de passe reste opérant : le backend ne l'interdit pas.
    expect(screen.getByRole('heading', { name: /Réinitialiser le mot de passe/ })).toBeTruthy();
  });
});
