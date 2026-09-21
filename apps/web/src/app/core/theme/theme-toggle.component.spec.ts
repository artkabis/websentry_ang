import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggleComponent } from './theme-toggle.component';
import { ThemeService } from './theme.service';

describe('ThemeToggleComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  function monter() {
    return render(ThemeToggleComponent, { providers: [provideZonelessChangeDetection()] });
  }

  it('offre les trois apparences, nommées', async () => {
    await monter();

    expect(screen.getByRole('radio', { name: 'Clair' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sombre' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Système' })).toBeTruthy();
  });

  it('EXPOSE l’apparence courante, et non le seul style du bouton', async () => {
    // Un état signalé par la seule couleur de fond n'existe pas pour un
    // lecteur d'écran : c'est la case cochée qui l'énonce.
    const { fixture } = await monter();
    fixture.debugElement.injector.get(ThemeService).set('sombre');
    fixture.detectChanges();

    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Sombre' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Clair' }).checked).toBe(false);
  });

  it('applique l’apparence choisie', async () => {
    const { fixture } = await monter();

    screen.getByRole('radio', { name: 'Sombre' }).click();
    fixture.detectChanges();

    expect(document.documentElement.getAttribute('data-theme')).toBe('sombre');
    expect(fixture.debugElement.injector.get(ThemeService).preference()).toBe('sombre');
  });

  it('porte un intitulé de groupe pour les lecteurs d’écran', async () => {
    await monter();

    // Sans lui, trois cases isolées énoncent « Clair », « Sombre »,
    // « Système » sans dire de quoi il s'agit.
    expect(screen.getByRole('group', { name: 'Apparence' })).toBeTruthy();
  });
});
