import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { LoginComponent } from './login.component';

/**
 * Tests orientés UTILISATEUR : les éléments sont retrouvés par leur libellé et
 * leur rôle, jamais par une classe CSS ou une structure interne. Une refonte du
 * balisage ne casse donc pas ces tests tant que l'écran reste utilisable.
 */
function setup(over: { login?: ReturnType<typeof vi.fn>; error?: string | null; retour?: string } = {}) {
  const login = over.login ?? vi.fn().mockResolvedValue({ role: 'tester', username: 'alice' });
  const navigateByUrl = vi.fn().mockResolvedValue(true);

  const auth = { login, error: () => over.error ?? null };
  const route = {
    snapshot: {
      queryParamMap: convertToParamMap(over.retour ? { retour: over.retour } : {}),
    },
  };

  return {
    login,
    navigateByUrl,
    providers: [
      provideZonelessChangeDetection(),
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: { navigateByUrl } },
      { provide: ActivatedRoute, useValue: route },
    ],
  };
}

describe('LoginComponent', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it('affiche le formulaire de connexion', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });

    expect(screen.getByLabelText('Identifiant')).toBeDefined();
    expect(screen.getByLabelText('Mot de passe')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDefined();
  });

  it('n’affiche AUCUNE erreur au chargement', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/L'identifiant est requis/)).toBeNull();
  });

  it('transmet les identifiants saisis au service', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'MonMotDePasse');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(t.login).toHaveBeenCalledWith('alice', 'MonMotDePasse');
  });

  it('redirige vers le tableau de bord après connexion', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'mdp');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(t.navigateByUrl).toHaveBeenCalledWith('/tableau-de-bord');
  });

  it('honore le paramètre `retour` posé par la garde', async () => {
    const t = setup({ retour: '/historique' });
    await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'mdp');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(t.navigateByUrl).toHaveBeenCalledWith('/historique');
  });

  it('N’APPELLE PAS l’API quand le formulaire est vide', async () => {
    // La validation client évite un aller-retour inutile ; le serveur revalide
    // de toute façon.
    const t = setup();
    await render(LoginComponent, { providers: t.providers });

    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(t.login).not.toHaveBeenCalled();
    expect(await screen.findByText(/L'identifiant est requis/)).toBeDefined();
    expect(screen.getByText(/Le mot de passe est requis/)).toBeDefined();
  });

  it('affiche le message d’erreur renvoyé par l’API', async () => {
    const t = setup({
      login: vi.fn().mockRejectedValue(new Error('401')),
      error: 'Identifiants incorrects',
    });
    await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Identifiants incorrects');
    expect(t.navigateByUrl).not.toHaveBeenCalled();
  });

  it('ÉCHAPPE un message d’erreur contenant du balisage', async () => {
    // Le message vient de l'API : s'il contenait du HTML, l'interpolation Angular
    // l'affiche comme du texte plutôt que de l'interpréter.
    const t = setup({
      login: vi.fn().mockRejectedValue(new Error('401')),
      error: '<img src=x onerror="alert(1)">',
    });
    const { container } = await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'x');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    await screen.findByRole('alert');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('<img src=x');
  });

  it('EFFACE le mot de passe après un échec', async () => {
    const t = setup({
      login: vi.fn().mockRejectedValue(new Error('401')),
      error: 'Identifiants incorrects',
    });
    await render(LoginComponent, { providers: t.providers });

    await user.type(screen.getByLabelText('Identifiant'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');

    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).value).toBe('');
    // L'identifiant est conservé : le retaper à chaque essai serait pénible.
    expect((screen.getByLabelText('Identifiant') as HTMLInputElement).value).toBe('alice');
  });

  it('borne la saisie aux longueurs du schéma partagé', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });

    expect(screen.getByLabelText('Identifiant').getAttribute('maxlength')).toBe('64');
    expect(screen.getByLabelText('Mot de passe').getAttribute('maxlength')).toBe('256');
  });

  it('masque la saisie du mot de passe', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });
    expect(screen.getByLabelText('Mot de passe').getAttribute('type')).toBe('password');
  });

  it('propose les bons indices d’autocomplétion', async () => {
    const t = setup();
    await render(LoginComponent, { providers: t.providers });
    expect(screen.getByLabelText('Identifiant').getAttribute('autocomplete')).toBe('username');
    expect(screen.getByLabelText('Mot de passe').getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });
});
