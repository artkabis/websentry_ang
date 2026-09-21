import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { ThemeToggleComponent } from './core/theme/theme-toggle.component';

/**
 * Composant racine.
 *
 * Il retient l'affichage tant que la session initiale n'est pas résolue : sans ce
 * garde-fou, un utilisateur déjà connecté verrait l'écran de connexion clignoter
 * avant d'être redirigé.
 *
 * La barre supérieure est volontairement MINCE : le choix d'apparence doit
 * exister sur tous les écrans, et chaque écran porte déjà son propre en-tête et
 * son titre. Une vraie coquille applicative — navigation, fil d'Ariane — reste
 * à proposer ; l'ajouter ici reviendrait à refondre tous les écrans au passage.
 */
@Component({
  selector: 'ws-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, ThemeToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.loading()) {
      <div class="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span class="text-sm text-content-subtle">Chargement…</span>
      </div>
    } @else {
      <header class="border-b border-line bg-panel">
        <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2">
          @if (auth.user()) {
            <a
              routerLink="/tableau-de-bord"
              class="text-sm font-semibold text-content hover:text-brand-text"
            >
              WebSentry
            </a>
          } @else {
            <span class="text-sm font-semibold text-content">WebSentry</span>
          }
          <ws-theme-toggle />
        </div>
      </header>
      <router-outlet />
    }
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
}
