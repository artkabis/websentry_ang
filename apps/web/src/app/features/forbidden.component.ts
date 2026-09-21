import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Écran d'accès refusé — affiché quand une garde de rang ou de permission bloque. */
@Component({
  selector: 'ws-forbidden',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 class="text-2xl font-semibold text-content">Accès refusé</h1>
      <p class="text-sm text-content-subtle">
        Votre compte ne dispose pas des droits nécessaires pour cette page.
      </p>
      <a routerLink="/tableau-de-bord" class="text-sm font-medium text-brand-text hover:underline">
        Retour au tableau de bord
      </a>
    </main>
  `,
})
export class ForbiddenComponent {}
