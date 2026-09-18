import { provideZonelessChangeDetection } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { RANKS, type ProfileMeta } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { ProfilesApi } from '../../core/profiles/profiles.api';
import { ProfilesListComponent } from './profiles-list.component';

function meta(over: Partial<ProfileMeta> = {}): ProfileMeta {
  return {
    profile: 'premium',
    label: 'Premium',
    description: null,
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T10:30:00.000Z',
    updatedBy: 'alice',
    ...over,
  };
}

/**
 * Le VRAI routeur est fourni : `routerLink` en dépend pour construire ses URL,
 * et le remplacer par un double casse le rendu. Seule la navigation est
 * espionnée, sur l'instance réelle.
 */
function setup(opts: { rank?: number; list?: ReturnType<typeof vi.fn> } = {}) {
  const list = opts.list ?? vi.fn().mockResolvedValue([meta()]);
  const rank = opts.rank ?? RANKS.ADMIN;

  return {
    list,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ProfilesApi, useValue: { list } },
      { provide: AuthService, useValue: { isAdmin: () => rank >= RANKS.ADMIN } },
    ],
  };
}

/** Espionne `navigate` sur le routeur réellement injecté. */
function spyOnNavigate(): ReturnType<typeof vi.fn> {
  const router = TestBed.inject(Router);
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(router, 'navigate').mockImplementation(navigate);
  return navigate;
}

describe('ProfilesListComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('affiche les profils chargés', async () => {
    const t = setup();
    await render(ProfilesListComponent, { providers: t.providers });

    expect(await screen.findByText('Premium')).toBeDefined();
    expect(screen.getByText(/version 2/)).toBeDefined();
    expect(screen.getByText(/par alice/)).toBeDefined();
  });

  it('signale le profil de repli', async () => {
    const t = setup({
      list: vi.fn().mockResolvedValue([meta({ profile: 'default', label: 'Défaut' })]),
    });
    await render(ProfilesListComponent, { providers: t.providers });

    expect(await screen.findByText('Repli')).toBeDefined();
  });

  it('MASQUE la création à un non-administrateur', async () => {
    const t = setup({ rank: RANKS.TESTER });
    await render(ProfilesListComponent, { providers: t.providers });

    await screen.findByText('Premium');
    expect(screen.queryByRole('button', { name: 'Nouveau profil' })).toBeNull();
  });

  it('propose la création à un administrateur', async () => {
    const t = setup();
    await render(ProfilesListComponent, { providers: t.providers });

    expect(await screen.findByRole('button', { name: 'Nouveau profil' })).toBeDefined();
  });

  it('signale une liste vide sans erreur', async () => {
    const t = setup({ list: vi.fn().mockResolvedValue([]) });
    await render(ProfilesListComponent, { providers: t.providers });

    expect(await screen.findByText('Aucun profil enregistré.')).toBeDefined();
  });

  it('affiche une erreur lisible quand le chargement échoue', async () => {
    const t = setup({ list: vi.fn().mockRejectedValue(new Error('réseau')) });
    await render(ProfilesListComponent, { providers: t.providers });

    expect(await screen.findByRole('alert')).toBeDefined();
  });

  describe('création', () => {
    it('NORMALISE la saisie avant de naviguer', async () => {
      // L'utilisateur voit immédiatement ce qui sera retenu, et l'URL reste lisible.
      vi.stubGlobal('prompt', () => 'START Plus!');
      const user = userEvent.setup();
      const t = setup();
      await render(ProfilesListComponent, { providers: t.providers });
      const navigate = spyOnNavigate();

      await user.click(await screen.findByRole('button', { name: 'Nouveau profil' }));
      expect(navigate).toHaveBeenCalledWith(['/profils', 'startplus']);
    });

    it('n’ouvre rien si la saisie est annulée', async () => {
      vi.stubGlobal('prompt', () => null);
      const user = userEvent.setup();
      const t = setup();
      await render(ProfilesListComponent, { providers: t.providers });
      const navigate = spyOnNavigate();

      await user.click(await screen.findByRole('button', { name: 'Nouveau profil' }));
      expect(navigate).not.toHaveBeenCalled();
    });

    it('REFUSE une saisie qui ne laisse rien après normalisation', async () => {
      vi.stubGlobal('prompt', () => '!!!');
      const user = userEvent.setup();
      const t = setup();
      await render(ProfilesListComponent, { providers: t.providers });
      const navigate = spyOnNavigate();

      await user.click(await screen.findByRole('button', { name: 'Nouveau profil' }));
      expect(navigate).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toBeDefined();
    });
  });
});
