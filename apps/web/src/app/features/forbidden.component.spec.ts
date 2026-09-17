import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { ForbiddenComponent } from './forbidden.component';

describe('ForbiddenComponent', () => {
  it('annonce le refus et propose un retour', async () => {
    await render(ForbiddenComponent, {
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });

    expect(screen.getByRole('heading', { name: 'Accès refusé' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Retour au tableau de bord/ })).toBeDefined();
  });
});
