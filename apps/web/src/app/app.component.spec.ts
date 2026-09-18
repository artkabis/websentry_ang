import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { AuthService } from './core/auth/auth.service';

function providers(loading: boolean) {
  return [
    provideZonelessChangeDetection(),
    provideRouter([]),
    { provide: AuthService, useValue: { loading: () => loading } },
  ];
}

describe('AppComponent', () => {
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
});
