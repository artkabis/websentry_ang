import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ALL_PERMISSIONS, type UserPermission } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';

/**
 * Permissions fines d'un compte.
 *
 * La liste proposée est limitée à ce que l'ACTEUR détient lui-même : le service
 * refuse de déléguer ce qu'on n'a pas, et offrir le choix pour le rejeter
 * ensuite en 403 ne rendrait service à personne. Le super_admin voit tout.
 */
@Component({
  selector: 'ws-user-permissions',
  standalone: true,
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
      <h2 class="text-base font-medium text-content">Permissions fines</h2>
      <p class="mt-1 text-sm text-content-subtle">
        Elles s'ajoutent à ce que le rang accorde déjà. Une portée vide vaut « toutes les gammes ».
      </p>

      <p role="status" aria-live="polite" class="mt-3 text-sm text-content-subtle">
        {{ messageEtat() }}
      </p>

      @if (erreur(); as message) {
        <p role="alert" class="mt-2 rounded-lg bg-danger-surface p-3 text-sm text-danger-content">
          {{ message }}
        </p>
      }

      @if (chargement()) {
        <div class="mt-3 space-y-2" aria-hidden="true">
          <div class="h-10 animate-pulse rounded-lg bg-sunken"></div>
          <div class="h-10 animate-pulse rounded-lg bg-sunken"></div>
        </div>
      } @else if (permissions().length === 0) {
        <p class="mt-3 rounded-lg bg-sunken p-4 text-sm text-content-muted">
          Aucune permission fine. Ce compte n'a que ce que son rang lui donne.
        </p>
      } @else {
        <ul class="mt-3 divide-y divide-line rounded-lg ring-1 ring-line">
          @for (accordee of permissions(); track accordee.permission) {
            <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <code class="text-sm text-content">{{ accordee.permission }}</code>
                <span class="ml-2 text-xs text-content-subtle">{{ portee(accordee) }}</span>
                <span class="block text-xs text-content-subtle">
                  accordée le {{ accordee.grantedAt | date: 'dd/MM/yyyy' }}
                  @if (accordee.expiresAt) {
                    — expire le {{ accordee.expiresAt | date: 'dd/MM/yyyy' }}
                  }
                </span>
              </div>
              @if (modifiable()) {
                <button
                  type="button"
                  (click)="revoquer(accordee.permission)"
                  [disabled]="enCours() !== null"
                  [attr.aria-label]="'Révoquer ' + accordee.permission"
                  class="rounded-lg px-3 py-1.5 text-sm font-medium text-danger-content hover:bg-danger-surface disabled:opacity-50"
                >
                  @if (enCours() === accordee.permission) {
                    Révocation…
                  } @else {
                    Révoquer
                  }
                </button>
              }
            </li>
          }
        </ul>
      }

      @if (modifiable()) {
        <form class="mt-4 border-t border-line pt-4" (ngSubmit)="accorder()">
          <fieldset class="grid gap-3 sm:grid-cols-2">
            <legend class="text-sm font-medium text-content">Accorder une permission</legend>

            <label class="block">
              <span class="text-xs font-medium text-content-muted">Permission</span>
              <select
                name="permission"
                [ngModel]="choix()"
                (ngModelChange)="choix.set($event)"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
              >
                <option value="">Choisir…</option>
                @for (code of delegables(); track code) {
                  <option [value]="code">{{ code }}</option>
                }
              </select>
            </label>

            <label class="block">
              <span class="text-xs font-medium text-content-muted">
                Portée (gammes séparées par des virgules)
              </span>
              <input
                type="text"
                name="gammes"
                [ngModel]="gammes()"
                (ngModelChange)="gammes.set($event)"
                placeholder="laisser vide pour toutes"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
              />
            </label>
          </fieldset>

          <button
            type="submit"
            [disabled]="choix() === '' || enCours() !== null"
            class="mt-3 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            @if (enCours() === 'octroi') {
              Octroi en cours…
            } @else {
              Accorder
            }
          </button>
        </form>
      }
    </section>
  `,
})
export class UserPermissionsComponent {
  private readonly api = inject(UsersApi);
  private readonly auth = inject(AuthService);

  readonly userId = input.required<string>();
  /** Faux quand l'acteur n'a pas `users:write` — la liste reste consultable. */
  readonly modifiable = input(true);

  readonly permissions = signal<UserPermission[]>([]);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);
  /** Code en cours de révocation, `'octroi'` pendant un octroi, sinon `null`. */
  readonly enCours = signal<string | null>(null);

  readonly choix = signal('');
  readonly gammes = signal('');

  /** Ce que l'acteur peut déléguer — jamais plus que ce qu'il détient. */
  readonly delegables = computed(() =>
    ALL_PERMISSIONS.filter(code => this.auth.hasPermission(code)),
  );

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement des permissions…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const nombre = this.permissions().length;
    return nombre === 0 ? 'Aucune permission fine.' : `${nombre} permission(s) accordée(s).`;
  });

  constructor() {
    // Un effet, et non un appel depuis le constructeur : `userId` est une
    // entrée REQUISE, que le constructeur s'exécute trop tôt pour lire. Le
    // chargement suit en prime un changement de compte.
    effect(() => {
      const id = this.userId();
      void this.charger(id);
    });
  }

  async charger(id = this.userId()): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      this.permissions.set(await this.api.listPermissions(id));
    } catch {
      this.erreur.set('Impossible de charger les permissions de ce compte.');
      this.permissions.set([]);
    } finally {
      this.chargement.set(false);
    }
  }

  async accorder(): Promise<void> {
    const code = this.choix();
    if (code === '') return;

    this.enCours.set('octroi');
    this.erreur.set(null);
    try {
      // Une portée vide vaut « toutes les gammes » : le schéma refuse un
      // tableau vide, qui serait un octroi n'accordant rien.
      const portee = this.gammes()
        .split(',')
        .map(g => g.trim())
        .filter(g => g !== '');

      await this.api.grantPermission(this.userId(), {
        permission: code,
        gammes: portee.length === 0 ? null : portee,
        expiresAt: null,
      });
      this.choix.set('');
      this.gammes.set('');
      await this.charger();
    } catch {
      this.erreur.set('L’octroi a échoué. La permission n’a pas été accordée.');
    } finally {
      this.enCours.set(null);
    }
  }

  /** Portée en un seul fragment : « toutes gammes » dit ce que `null` signifie. */
  portee(accordee: UserPermission): string {
    return accordee.gammes === null ? 'toutes gammes' : `gammes : ${accordee.gammes.join(', ')}`;
  }

  async revoquer(permission: string): Promise<void> {
    this.enCours.set(permission);
    this.erreur.set(null);
    try {
      await this.api.revokePermission(this.userId(), permission);
      await this.charger();
    } catch {
      this.erreur.set('La révocation a échoué. La permission est toujours accordée.');
    } finally {
      this.enCours.set(null);
    }
  }
}
