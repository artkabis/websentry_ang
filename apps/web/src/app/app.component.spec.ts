import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { AuthService } from './core/auth/auth.service';

function providers(loading: boolean, user: unknown = null) {
  return [
    provideZonelessChangeDetection(),
    provideRouter([]),
    { provide: AuthService, useValue: { loading: () => loading, user: () => user } },
  ];
}

describe('AppComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('retient l’affichage tant que la session n’est pas résolue', async () => {
    // Sans ce garde-fou, un utilisateur déjà connecté verrait l'écran de
    // connexion clignoter avant d'être redirigé.
    await render(AppComponent, { providers: providers(true) });
    expect(screen.getByRole('status').textContent).toContain('Chargement');
  });

  it('rend la route une fois la session résolue', async () => {
    await render(AppComponent, { providers: providers(false) });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('OFFRE le choix d’apparence sur tous les écrans, connecté ou non', async () => {
    // Le réglage doit exister avant la connexion : c'est justement l'écran
    // qu'un utilisateur voit le plus souvent en premier, et le soir.
    await render(AppComponent, { providers: providers(false) });

    expect(screen.getByRole('radio', { name: 'Sombre' })).toBeTruthy();
  });

  it('ne propose pas le retour au tableau de bord à un visiteur', async () => {
    await render(AppComponent, { providers: providers(false) });

    expect(screen.queryByRole('link', { name: 'WebSentry' })).toBeNull();
  });

  it('ramène au tableau de bord depuis n’importe quel écran, une fois connecté', async () => {
    await render(AppComponent, { providers: providers(false, { username: 'alice' }) });

    const lien = screen.getByRole('link', { name: 'WebSentry' });
    expect(lien.getAttribute('href')).toBe('/tableau-de-bord');
  });
});
