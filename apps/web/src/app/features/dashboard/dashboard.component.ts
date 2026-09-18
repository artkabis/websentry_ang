import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

/**
 * Tableau de bord — coquille de la priorité 1.
 *
 * Il valide la chaîne complète (session, profil, rôle, déconnexion) ; les modules
 * fonctionnels viendront s'y greffer aux étapes suivantes de la migration.
 */
@Component({
  selector: 'ws-dashboard',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold text-slate-900">Tableau de bord</h1>
          @if (auth.user(); as user) {
            <p class="mt-1 text-sm text-slate-500">
              Connecté en tant que <strong>{{ user.username }}</strong> — {{ auth.role() }}
            </p>
          }
        </div>
        <button
          type="button"
          (click)="logout()"
          class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700
                 hover:bg-slate-50"
        >
          Se déconnecter
        </button>
      </header>

      <section class="mt-8 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 class="text-base font-medium text-slate-900">Profils par gamme</h2>
        <p class="mt-1 text-sm text-slate-500">
          Règles d'analyse appliquées selon la gamme du site audité.
        </p>
        <a
          routerLink="/profils"
          class="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Consulter les profils
        </a>
      </section>

      @if (auth.isAdmin()) {
        <section class="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 class="text-base font-medium text-slate-900">Administration</h2>
          <p class="mt-1 text-sm text-slate-500">
            Section réservée aux rangs administrateur et supérieurs.
          </p>
        </section>
      }

      @if (auth.user(); as user) {
        <section class="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 class="text-base font-medium text-slate-900">Permissions accordées</h2>
          @if (user.permissions.length === 0) {
            <p class="mt-1 text-sm text-slate-500">Aucune permission fine accordée.</p>
          } @else {
            <ul class="mt-2 space-y-1 text-sm text-slate-600">
              @for (permission of user.permissions; track permission.permission) {
                <li>
                  <code>{{ permission.permission }}</code>
                  @if (permission.gammes) {
                    <span class="text-slate-400">
                      — gammes : {{ permission.gammes.join(', ') }}</span
                    >
                  }
                </li>
              }
            </ul>
          }
        </section>
      }
    </main>
  `,
})
export class DashboardComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/connexion');
  }
}
