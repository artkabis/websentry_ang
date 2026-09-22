import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ASSIGNABLE_RANKS, type UserSummary } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';
import {
  FILTRES_VIDES,
  filtresActifs,
  filtresDepuisParams,
  filtresVersRequete,
  libelleRang,
  libelleStatut,
  nombreDePages,
  paramsDepuisFiltres,
  refusPrevisible,
  TAILLE_PAGE,
  type UserFilterState,
} from './user-filters';

/** Lignes du squelette — calquées sur une page pleine. */
const LIGNES_SQUELETTE = 8;

/**
 * Liste des comptes.
 *
 * Le tri est celui du backend — rang décroissant puis identifiant — et n'est
 * pas réglable : l'API ne l'expose pas, et proposer des en-têtes cliquables qui
 * ne trieraient rien serait pire que de ne rien proposer.
 *
 * Les gestes que les garde-fous du service refuseraient sont DÉSACTIVÉS avec
 * leur raison, plutôt que proposés puis rejetés en 403 (cf. `user-filters.ts`,
 * `refusPrevisible`). Ce n'est pas une protection — l'API reste la seule
 * autorité — c'est une explication donnée avant le clic.
 */
@Component({
  selector: 'ws-users-list',
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-6xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Comptes</h1>
          <p class="mt-1 text-sm text-content-subtle">
            Rangs, statuts et permissions des personnes qui utilisent WebSentry.
          </p>
        </div>
        @if (peutEcrire()) {
          <a
            routerLink="/administration/comptes/nouveau"
            class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Créer un compte
          </a>
        }
      </header>

      <!-- Filtres : appliqués à la soumission, reflétés dans l'URL. -->
      <form
        class="mt-6 rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line"
        (ngSubmit)="appliquerBrouillon()"
      >
        <fieldset class="grid gap-3 sm:grid-cols-3">
          <legend class="sr-only">Filtres</legend>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Recherche</span>
            <input
              type="search"
              name="recherche"
              [ngModel]="brouillonRecherche()"
              (ngModelChange)="brouillonRecherche.set($event)"
              placeholder="identifiant, nom ou courriel"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Rang</span>
            <select
              name="rang"
              [ngModel]="brouillonRang()"
              (ngModelChange)="brouillonRang.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Tous les rangs</option>
              @for (rang of rangs; track rang) {
                <option [value]="rang">{{ nomRang(rang) }}</option>
              }
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Statut</span>
            <select
              name="statut"
              [ngModel]="brouillonStatut()"
              (ngModelChange)="brouillonStatut.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Tous les statuts</option>
              <option value="active">Actif</option>
              <option value="suspended">Suspendu</option>
              <option value="pending">En attente</option>
            </select>
          </label>
        </fieldset>

        <div class="mt-3 flex items-center gap-2">
          <button
            type="submit"
            class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Filtrer
          </button>
          @if (filtresPoses()) {
            <button
              type="button"
              (click)="reinitialiser()"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken"
            >
              Réinitialiser
            </button>
          }
        </div>
      </form>

      <p role="status" aria-live="polite" class="mt-6 text-sm text-content-subtle">
        {{ messageEtat() }}
      </p>

      @if (erreur(); as message) {
        <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
          <button
            type="button"
            (click)="recharger()"
            class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
          >
            Réessayer
          </button>
        </div>
      } @else if (chargement()) {
        <!-- Squelette calqué sur la forme réelle du tableau : la mise en page
             ne saute pas quand les données arrivent. -->
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (ligne of squelette; track ligne) {
            <div class="h-14 animate-pulse rounded-lg bg-sunken"></div>
          }
        </div>
      } @else if (comptes().length === 0) {
        <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
          @if (filtresPoses()) {
            <p class="text-sm text-content-muted">Aucun compte ne correspond à ces filtres.</p>
            <button
              type="button"
              (click)="reinitialiser()"
              class="mt-3 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Effacer les filtres
            </button>
          } @else {
            <p class="text-sm text-content-muted">Aucun compte pour l'instant.</p>
            <p class="mt-1 text-sm text-content-subtle">
              Créez un premier compte pour donner accès à WebSentry.
            </p>
          }
        </div>
      } @else {
        <div class="mt-3 overflow-x-auto rounded-xl bg-panel shadow-sm ring-1 ring-line">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">
              Comptes,
              {{
                total()
              }}
              au total, triés par rang décroissant
            </caption>
            <thead class="border-b border-line text-xs uppercase text-content-subtle">
              <tr>
                <th scope="col" class="px-4 py-2">Identifiant</th>
                <th scope="col" class="px-4 py-2">Rang</th>
                <th scope="col" class="px-4 py-2">Statut</th>
                <th scope="col" class="px-4 py-2">Scans lancés</th>
                <th scope="col" class="px-4 py-2">Créé le</th>
                <th scope="col" class="px-4 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (compte of comptes(); track compte.id) {
                <tr class="hover:bg-sunken">
                  <th scope="row" class="px-4 py-3 font-normal">
                    <span class="font-medium text-content">{{ compte.username }}</span>
                    @if (compte.id === idActeur()) {
                      <span
                        class="ml-2 rounded-full bg-brand-surface px-2 py-0.5 text-xs text-brand-text"
                      >
                        vous
                      </span>
                    }
                    @if (compte.displayName) {
                      <span class="block text-xs text-content-subtle">{{
                        compte.displayName
                      }}</span>
                    }
                  </th>
                  <td class="px-4 py-3 text-content-muted">{{ nomRang(compte.rank) }}</td>
                  <td class="px-4 py-3">
                    <span [class]="classeStatut(compte.status)">{{
                      nomStatut(compte.status)
                    }}</span>
                    @if (compte.lockedUntil) {
                      <span class="block text-xs text-warn-content">
                        verrouillé jusqu'au {{ compte.lockedUntil | date: 'dd/MM/yyyy HH:mm' }}
                      </span>
                    }
                  </td>
                  <td class="px-4 py-3 text-content-muted">{{ compte.totalScansLaunched }}</td>
                  <td class="px-4 py-3 text-content-muted">
                    {{ compte.createdAt | date: 'dd/MM/yyyy' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    @if (refus(compte); as raison) {
                      <!-- Pas de bouton mort : un texte explique pourquoi le
                           geste n'est pas offert, au lieu d'un 403 après coup. -->
                      <span class="text-xs text-content-subtle">{{ raison }}</span>
                    } @else {
                      <a
                        [routerLink]="['/administration/comptes', compte.id]"
                        [attr.aria-label]="'Ouvrir la fiche de ' + compte.username"
                        class="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-text hover:bg-sunken hover:underline"
                      >
                        Modifier
                      </a>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (pages() > 1) {
          <nav class="mt-4 flex items-center justify-between" aria-label="Pagination">
            <button
              type="button"
              (click)="allerALaPage(filtres().page - 1)"
              [disabled]="filtres().page <= 1"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page précédente
            </button>
            <span class="text-sm text-content-subtle">
              Page {{ filtres().page }} sur {{ pages() }}
            </span>
            <button
              type="button"
              (click)="allerALaPage(filtres().page + 1)"
              [disabled]="filtres().page >= pages()"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page suivante
            </button>
          </nav>
        }
      }
    </main>
  `,
})
export class UsersListComponent {
  private readonly api = inject(UsersApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly squelette = Array.from({ length: LIGNES_SQUELETTE }, (_, i) => i);
  readonly rangs = ASSIGNABLE_RANKS;

  /** Filtres lus depuis l'URL — source de vérité unique, jamais dupliquée. */
  readonly filtres = toSignal(
    this.route.queryParams.pipe(map(p => filtresDepuisParams(p as Record<string, string>))),
    { initialValue: FILTRES_VIDES },
  );

  readonly comptes = signal<UserSummary[]>([]);
  readonly total = signal(0);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);

  readonly brouillonRecherche = signal('');
  readonly brouillonRang = signal<string>('');
  readonly brouillonStatut = signal('');

  private derniereCle = '';

  readonly pages = computed(() => nombreDePages(this.total()));
  readonly filtresPoses = computed(() => filtresActifs(this.filtres()));
  readonly idActeur = computed(() => this.auth.user()?.id ?? null);
  readonly peutEcrire = computed(() => this.auth.hasPermission('users:write'));

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement des comptes…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const nombre = this.total();
    if (nombre === 0) return 'Aucun compte trouvé.';
    return `${nombre} compte(s) trouvé(s).`;
  });

  constructor() {
    // Le chargement SUIT l'URL : le bouton « Précédent » change les paramètres
    // sans reconstruire le composant, et un appel unique au démarrage
    // laisserait l'écran afficher le résultat de la recherche précédente.
    effect(() => {
      const filtres = this.filtres();
      this.brouillonRecherche.set(filtres.search);
      this.brouillonRang.set(filtres.rank === null ? '' : String(filtres.rank));
      this.brouillonStatut.set(filtres.status);
      void this.charger(filtres);
    });
  }

  async charger(filtres: UserFilterState = this.filtres()): Promise<void> {
    const cle = JSON.stringify(filtres);
    this.derniereCle = cle;

    this.chargement.set(true);
    this.erreur.set(null);

    try {
      const resultat = await this.api.list(filtresVersRequete(filtres, TAILLE_PAGE));
      // Une réponse plus lente qu'une navigation suivante ne doit pas écraser
      // l'affichage courant.
      if (this.derniereCle !== cle) return;
      this.comptes.set(resultat.users);
      this.total.set(resultat.total);
    } catch {
      if (this.derniereCle !== cle) return;
      this.erreur.set('Impossible de charger la liste des comptes.');
      this.comptes.set([]);
    } finally {
      if (this.derniereCle === cle) this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  appliquerBrouillon(): void {
    const rang = this.brouillonRang();
    void this.naviguer({
      search: this.brouillonRecherche().trim(),
      rank: rang === '' ? null : Number(rang),
      status: this.brouillonStatut(),
      // Tout changement de filtre ramène en page 1 : rester page 4 afficherait
      // un extrait arbitraire d'un résultat qui n'a plus rien à voir.
      page: 1,
    });
  }

  reinitialiser(): void {
    void this.naviguer(FILTRES_VIDES);
  }

  allerALaPage(page: number): void {
    void this.naviguer({ ...this.filtres(), page });
  }

  /** Raison du refus prévisible, ou `null` si le geste est permis. */
  refus(compte: UserSummary): string | null {
    const utilisateur = this.auth.user();
    if (!utilisateur || !this.peutEcrire()) return 'Lecture seule';
    return refusPrevisible(
      compte,
      { id: utilisateur.id ?? '', rank: utilisateur.rank },
      'modifier',
    );
  }

  nomRang(rank: number): string {
    return libelleRang(rank);
  }

  nomStatut(status: string): string {
    return libelleStatut(status);
  }

  /** Le libellé porte le sens ; la couleur ne fait que l'appuyer. */
  classeStatut(status: string): string {
    const socle = 'rounded-full px-2 py-0.5 text-xs';
    if (status === 'suspended') return `${socle} bg-danger-surface text-danger-content`;
    if (status === 'pending') return `${socle} bg-warn-surface text-warn-content`;
    return `${socle} bg-ok-surface text-ok-content`;
  }

  private naviguer(filtres: UserFilterState): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsDepuisFiltres(filtres),
      // Remplacer plutôt qu'empiler : sans quoi chaque frappe de filtre
      // ajouterait une entrée d'historique à défaire une par une.
      replaceUrl: false,
    });
  }
}
