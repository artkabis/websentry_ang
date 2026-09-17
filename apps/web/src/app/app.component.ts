import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';

/**
 * Composant racine.
 *
 * Il retient l'affichage tant que la session initiale n'est pas résolue : sans ce
 * garde-fou, un utilisateur déjà connecté verrait l'écran de connexion clignoter
 * avant d'être redirigé.
 */
@Component({
  selector: 'ws-root',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.loading()) {
      <div class="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span class="text-sm text-slate-500">Chargement…</span>
      </div>
    } @else {
      <router-outlet />
    }
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
}
