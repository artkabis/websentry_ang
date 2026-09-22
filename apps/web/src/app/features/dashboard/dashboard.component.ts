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
          <h1 class="text-2xl font-semibold text-content">Tableau de bord</h1>
          @if (auth.user(); as user) {
            <p class="mt-1 text-sm text-content-subtle">
              Connecté en tant que <strong>{{ user.username }}</strong> — {{ auth.role() }}
            </p>
          }
        </div>
        <button
          type="button"
          (click)="logout()"
          class="rounded-lg border border-field px-3 py-2 text-sm font-medium text-content-muted
                 hover:bg-sunken"
        >
          Se déconnecter
        </button>
      </header>

      <section class="mt-8 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
        <h2 class="text-base font-medium text-content">Profils par gamme</h2>
        <p class="mt-1 text-sm text-content-subtle">
          Règles d'analyse appliquées selon la gamme du site audité.
        </p>
        <a
          routerLink="/profils"
          class="mt-3 inline-block text-sm font-medium text-brand-text hover:underline"
        >
          Consulter les profils
        </a>
      </section>

      <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
        <h2 class="text-base font-medium text-content">Analyser une page</h2>
        <p class="mt-1 text-sm text-content-subtle">
          Audit d'une URL, critère par critère, avec les corrections prioritaires.
        </p>
        <a
          routerLink="/analyse"
          class="mt-3 inline-block text-sm font-medium text-brand-text hover:underline"
        >
          Lancer une analyse
        </a>
      </section>

      <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
        <h2 class="text-base font-medium text-content">Historique des scans</h2>
        <p class="mt-1 text-sm text-content-subtle">
          Audits passés, site par site, et comparaison de deux analyses.
        </p>
        <a
          routerLink="/historique"
          class="mt-3 inline-block text-sm font-medium text-brand-text hover:underline"
        >
          Consulter l'historique
        </a>
      </section>

      @if (
        auth.hasPermission('users:read') || auth.hasPermission('health:read') || auth.isSuperAdmin()
      ) {
        <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
          <h2 class="text-base font-medium text-content">Administration</h2>
          <p class="mt-1 text-sm text-content-subtle">
            Comptes, rangs et permissions. Le journal d'audit est réservé au rang le plus élevé.
          </p>
          <div class="mt-3 flex flex-wrap gap-4">
            @if (auth.hasPermission('users:read')) {
              <a
                routerLink="/administration/comptes"
                class="text-sm font-medium text-brand-text hover:underline"
              >
                Gérer les comptes
              </a>
            }
            @if (auth.hasPermission('health:read')) {
              <a
                routerLink="/administration/supervision"
                class="text-sm font-medium text-brand-text hover:underline"
              >
                Superviser l'instance
              </a>
            }
            @if (auth.isSuperAdmin()) {
              <a
                routerLink="/administration/journal"
                class="text-sm font-medium text-brand-text hover:underline"
              >
                Consulter le journal d'audit
              </a>
            }
          </div>
        </section>
      }

      @if (auth.user(); as user) {
        <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
          <h2 class="text-base font-medium text-content">Permissions accordées</h2>
          @if (user.permissions.length === 0) {
            <p class="mt-1 text-sm text-content-subtle">Aucune permission fine accordée.</p>
          } @else {
            <ul class="mt-2 space-y-1 text-sm text-content-muted">
              @for (permission of user.permissions; track permission.permission) {
                <li>
                  <code>{{ permission.permission }}</code>
                  @if (permission.gammes) {
                    <span class="text-content-subtle">
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
