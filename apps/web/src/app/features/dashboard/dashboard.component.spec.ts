import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { rankHasPermission, RANKS, type CurrentUser } from '@websentry/shared';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { DashboardComponent } from './dashboard.component';

function profile(rank: number, permissions: CurrentUser['permissions'] = []): CurrentUser {
  return { id: 'u1', username: 'alice', rank, role: 'tester', status: 'active', permissions };
}

/**
 * Le VRAI routeur est fourni : le tableau de bord porte un `routerLink` vers les
 * profils, et remplacer le routeur par un double casse la construction d'URL de
 * la directive. Seule la navigation est espionnée, sur l'instance réelle.
 */
function setup(user: CurrentUser | null, role = 'tester') {
  const logout = vi.fn().mockResolvedValue(undefined);

  const auth = {
    user: () => user,
    role: () => role,
    isAdmin: () => (user?.rank ?? 0) >= RANKS.ADMIN,
    isSuperAdmin: () => (user?.rank ?? 0) >= RANKS.SUPER_ADMIN,
    // Même règle que le service réel : le rang donne ses permissions par
    // défaut, et le super_admin détient tout.
    hasPermission: (code: string) =>
      (user?.rank ?? 0) >= RANKS.SUPER_ADMIN ||
      rankHasPermission(user?.rank ?? 0, code) ||
      (user?.permissions ?? []).some(p => p.permission === code),
    logout,
  };

  return {
    logout,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthService, useValue: auth },
    ],
  };
}

/** Espionne `navigateByUrl` sur le routeur réellement injecté. */
function spyOnNavigate(): ReturnType<typeof vi.fn> {
  const navigateByUrl = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation(navigateByUrl);
  return navigateByUrl;
}

describe('DashboardComponent', () => {
  it('affiche l’utilisateur connecté et son rôle', async () => {
    const t = setup(profile(RANKS.TESTER), 'tester');
    await render(DashboardComponent, { providers: t.providers });

    expect(screen.getByRole('heading', { name: 'Tableau de bord' })).toBeDefined();
    expect(screen.getByText(/alice/)).toBeDefined();
    expect(screen.getByText(/tester/)).toBeDefined();
  });

  it('MASQUE la section d’administration à un tester', async () => {
    const t = setup(profile(RANKS.TESTER));
    await render(DashboardComponent, { providers: t.providers });
    expect(screen.queryByRole('heading', { name: 'Administration' })).toBeNull();
  });

  it('mène un admin aux comptes, mais PAS au journal', async () => {
    // `audit:read` reste réservé au rang 100 : proposer le lien mènerait à un
    // écran d'accès refusé.
    const t = setup(profile(RANKS.ADMIN), 'admin');
    await render(DashboardComponent, { providers: t.providers });

    expect(screen.getByRole('heading', { name: 'Administration' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Gérer les comptes/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: /journal d'audit/ })).toBeNull();
  });

  it('mène un super_admin aux comptes ET au journal', async () => {
    const t = setup(profile(RANKS.SUPER_ADMIN), 'super_admin');
    await render(DashboardComponent, { providers: t.providers });

    expect(screen.getByRole('link', { name: /Gérer les comptes/ })).toBeDefined();
    expect(screen.getByRole('link', { name: /journal d'audit/ })).toBeDefined();
  });

  it('signale l’absence de permission fine', async () => {
    const t = setup(profile(RANKS.TESTER, []));
    await render(DashboardComponent, { providers: t.providers });
    expect(screen.getByText('Aucune permission fine accordée.')).toBeDefined();
  });

  it('liste les permissions accordées avec leur scope', async () => {
    const t = setup(
      profile(RANKS.EDITOR, [
        { permission: 'docs:read', gammes: ['premium', 'essentiel'] },
        { permission: 'usage:read', gammes: null },
      ]),
    );
    await render(DashboardComponent, { providers: t.providers });

    expect(screen.getByText('docs:read')).toBeDefined();
    expect(screen.getByText(/premium, essentiel/)).toBeDefined();
    expect(screen.getByText('usage:read')).toBeDefined();
  });

  it('déconnecte puis redirige vers l’écran de connexion', async () => {
    const user = userEvent.setup();
    const t = setup(profile(RANKS.TESTER));
    await render(DashboardComponent, { providers: t.providers });
    const navigateByUrl = spyOnNavigate();

    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }));

    expect(t.logout).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/connexion');
  });

  it('reste affichable sans profil résolu', async () => {
    const t = setup(null);
    await render(DashboardComponent, { providers: t.providers });
    expect(screen.getByRole('heading', { name: 'Tableau de bord' })).toBeDefined();
  });
});
