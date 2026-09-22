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
import type { Feedback, FeedbackCounts, FeedbackStatus } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { FeedbackApi } from '../../core/feedback/feedback.api';
import {
  FILTRES_RETOURS_VIDES,
  filtresRetoursActifs,
  filtresRetoursDepuisParams,
  filtresRetoursVersRequete,
  GRAVITES,
  libelleGravite,
  libelleStatutRetour,
  libelleType,
  nombreDePagesRetours,
  paramsDepuisFiltresRetours,
  statutsAtteignables,
  STATUTS,
  TAILLE_PAGE_RETOURS,
  TYPES,
  type FeedbackFilterState,
} from './feedback-form';

const LIGNES_SQUELETTE = 5;

/**
 * Retours — liste et triage.
 *
 * Le même écran sert deux publics, parce que la donnée est la même et que
 * l'auteur doit pouvoir suivre ce qu'il a signalé : qui détient
 * `feedback:read` voit tous les retours et peut les faire avancer ; les autres
 * ne voient que les leurs, en lecture. La restriction est appliquée par l'API,
 * pas ici — l'interface ne fait que ne pas proposer ce qu'elle sait refusé.
 *
 * Aucun geste de suppression : l'API n'en offre pas, et le proposer donnerait
 * une fausse idée de ce qui est garanti à celui qui dépose un retour.
 */
@Component({
  selector: 'ws-feedback-list',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-5xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Retours</h1>
          <p class="mt-1 text-sm text-content-subtle">
            @if (peutTrier()) {
              Ce que l'équipe a signalé, et où en est chaque point.
            } @else {
              Ce que vous avez signalé, et où en est chaque point.
            }
          </p>
        </div>
        <a
          routerLink="/retours/nouveau"
          class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
        >
          Signaler quelque chose
        </a>
      </header>

      <!-- Compteurs : tous les statuts, zéros compris. Masquer ceux à zéro
           ferait croire qu'ils n'existent pas. -->
      @if (compteurs(); as totaux) {
        <ul class="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
          @for (statut of statuts; track statut) {
            <li>
              <button
                type="button"
                (click)="filtrerParStatut(statut)"
                [attr.aria-pressed]="filtres().status === statut"
                class="w-full rounded-lg bg-panel p-3 text-left ring-1 ring-line hover:bg-sunken aria-pressed:bg-sunken aria-pressed:ring-brand"
              >
                <span class="block text-xs text-content-subtle">{{ nomStatut(statut) }}</span>
                <span class="block text-lg font-semibold text-content">{{ totaux[statut] }}</span>
              </button>
            </li>
          }
        </ul>
      }

      <form
        class="mt-6 rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line"
        (ngSubmit)="appliquerBrouillon()"
      >
        <fieldset class="grid gap-3 sm:grid-cols-3">
          <legend class="sr-only">Filtres des retours</legend>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Recherche</span>
            <input
              type="search"
              name="recherche"
              [ngModel]="brouillonRecherche()"
              (ngModelChange)="brouillonRecherche.set($event)"
              placeholder="titre ou description"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Type</span>
            <select
              name="type"
              [ngModel]="brouillonType()"
              (ngModelChange)="brouillonType.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Tous les types</option>
              @for (type of types; track type) {
                <option [value]="type">{{ nomType(type) }}</option>
              }
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Gravité</span>
            <select
              name="gravite"
              [ngModel]="brouillonGravite()"
              (ngModelChange)="brouillonGravite.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Toutes les gravités</option>
              @for (gravite of gravites; track gravite) {
                <option [value]="gravite">{{ nomGravite(gravite) }}</option>
              }
            </select>
          </label>
        </fieldset>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Filtrer
          </button>
          @if (peutTrier()) {
            <!-- « Mes retours » n'a de sens que pour qui voit ceux des autres. -->
            <label class="flex items-center gap-2 text-sm text-content-muted">
              <input
                type="checkbox"
                name="miens"
                [ngModel]="brouillonMiens()"
                (ngModelChange)="brouillonMiens.set($event)"
                class="size-4 rounded border-field"
              />
              Seulement les miens
            </label>
          }
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
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (ligne of squelette; track ligne) {
            <div class="h-24 animate-pulse rounded-xl bg-sunken"></div>
          }
        </div>
      } @else if (retours().length === 0) {
        <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
          @if (filtresPoses()) {
            <p class="text-sm text-content-muted">Aucun retour ne correspond à ces filtres.</p>
            <button
              type="button"
              (click)="reinitialiser()"
              class="mt-3 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Effacer les filtres
            </button>
          } @else {
            <p class="text-sm text-content-muted">Aucun retour pour l'instant.</p>
            <p class="mt-1 text-sm text-content-subtle">
              Un comportement qui surprend, une étape de trop : c'est exactement ce qu'on cherche.
            </p>
            <a
              routerLink="/retours/nouveau"
              class="mt-3 inline-block rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Signaler quelque chose
            </a>
          }
        </div>
      } @else {
        <ul class="mt-3 space-y-3">
          @for (retour of retours(); track retour.id) {
            <li class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <article>
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <h2 class="text-base font-medium text-content">{{ retour.title }}</h2>
                  <span [class]="classeStatut(retour.status)">{{ nomStatut(retour.status) }}</span>
                </div>

                <p class="mt-1 text-xs text-content-subtle">
                  {{ nomType(retour.kind) }} · {{ nomGravite(retour.severity) }} ·
                  {{ retour.authorName ?? 'compte supprimé' }} ·
                  {{ retour.createdAt | date: 'dd/MM/yyyy' }}
                  @if (retour.assignedName) {
                    · confié à {{ retour.assignedName }}
                  }
                </p>

                <details class="mt-2" [open]="retour.id === ouvert()">
                  <summary class="cursor-pointer text-sm text-brand-text hover:underline">
                    Détail
                  </summary>
                  <p class="mt-2 whitespace-pre-wrap text-sm text-content-muted">
                    {{ retour.body }}
                  </p>
                  @if (retour.context.route) {
                    <p class="mt-2 text-xs text-content-subtle">
                      Depuis <code>{{ retour.context.route }}</code>
                      @if (retour.context.gamme) {
                        · gamme {{ retour.context.gamme }}
                      }
                    </p>
                  }
                  @if (retour.resolution) {
                    <p class="mt-2 rounded-lg bg-ok-surface p-3 text-sm text-ok-content">
                      {{ retour.resolution }}
                    </p>
                  }
                </details>

                @if (peutTrier()) {
                  <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <!-- Seuls les passages que l'API accepte sont offerts :
                         proposer les autres ferait découvrir l'interdit après
                         le clic. -->
                    @for (vers of passages(retour.status); track vers) {
                      <button
                        type="button"
                        (click)="avancer(retour, vers)"
                        [disabled]="enCours() !== null"
                        class="rounded-lg border border-field px-3 py-1.5 text-sm text-content-muted hover:bg-sunken disabled:opacity-50"
                      >
                        @if (enCours() === retour.id) {
                          …
                        } @else {
                          Marquer « {{ nomStatut(vers) }} »
                        }
                      </button>
                    }
                    @if (passages(retour.status).length === 0) {
                      <span class="text-xs text-content-subtle">Aucun passage possible.</span>
                    }
                  </div>
                }
              </article>
            </li>
          }
        </ul>

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
export class FeedbackListComponent {
  private readonly api = inject(FeedbackApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly squelette = Array.from({ length: LIGNES_SQUELETTE }, (_, i) => i);
  readonly statuts = STATUTS;
  readonly types = TYPES;
  readonly gravites = GRAVITES;

  readonly filtres = toSignal(
    this.route.queryParams.pipe(map(p => filtresRetoursDepuisParams(p as Record<string, string>))),
    { initialValue: FILTRES_RETOURS_VIDES },
  );

  /** Retour à déplier au chargement — celui qu'on vient de déposer. */
  readonly ouvert = toSignal(
    this.route.queryParams.pipe(map(p => (p as Record<string, string>)['ouvert'] ?? null)),
    { initialValue: null },
  );

  readonly retours = signal<Feedback[]>([]);
  readonly total = signal(0);
  readonly compteurs = signal<FeedbackCounts | null>(null);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);
  readonly enCours = signal<string | null>(null);

  readonly brouillonRecherche = signal('');
  readonly brouillonType = signal('');
  readonly brouillonGravite = signal('');
  readonly brouillonMiens = signal(false);

  private derniereCle = '';

  readonly peutTrier = computed(() => this.auth.hasPermission('feedback:read'));
  readonly pages = computed(() => nombreDePagesRetours(this.total()));
  readonly filtresPoses = computed(() => filtresRetoursActifs(this.filtres()));

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement des retours…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const nombre = this.total();
    if (nombre === 0) return 'Aucun retour trouvé.';
    return `${nombre} retour(s) trouvé(s).`;
  });

  constructor() {
    effect(() => {
      const filtres = this.filtres();
      this.brouillonRecherche.set(filtres.search);
      this.brouillonType.set(filtres.kind);
      this.brouillonGravite.set(filtres.severity);
      this.brouillonMiens.set(filtres.mine);
      void this.charger(filtres);
    });
  }

  async charger(filtres: FeedbackFilterState = this.filtres()): Promise<void> {
    const cle = JSON.stringify(filtres);
    this.derniereCle = cle;

    this.chargement.set(true);
    this.erreur.set(null);

    try {
      const [liste, compteurs] = await Promise.all([
        this.api.list(filtresRetoursVersRequete(filtres, TAILLE_PAGE_RETOURS)),
        this.api.counts(),
      ]);
      // Une réponse plus lente qu'une navigation suivante ne doit pas écraser
      // l'affichage courant.
      if (this.derniereCle !== cle) return;
      this.retours.set(liste.items);
      this.total.set(liste.total);
      this.compteurs.set(compteurs);
    } catch {
      if (this.derniereCle !== cle) return;
      this.erreur.set('Impossible de charger les retours.');
      this.retours.set([]);
    } finally {
      if (this.derniereCle === cle) this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  /**
   * Fait avancer un retour.
   *
   * Le résultat rendu par l'API remplace la ligne en place : recharger toute
   * la liste ferait sauter l'écran et perdrait le détail ouvert.
   */
  async avancer(retour: Feedback, vers: FeedbackStatus): Promise<void> {
    this.enCours.set(retour.id);
    this.erreur.set(null);
    try {
      const majour = await this.api.triage(retour.id, { status: vers });
      this.retours.update(liste => liste.map(r => (r.id === majour.id ? majour : r)));
      this.compteurs.set(await this.api.counts());
    } catch {
      this.erreur.set('Le changement de statut a échoué. Le retour est inchangé.');
    } finally {
      this.enCours.set(null);
    }
  }

  appliquerBrouillon(): void {
    void this.naviguer({
      ...this.filtres(),
      search: this.brouillonRecherche().trim(),
      kind: this.brouillonType(),
      severity: this.brouillonGravite(),
      mine: this.brouillonMiens(),
      page: 1,
    });
  }

  /** Un compteur agit comme un filtre : recliquer dessus le retire. */
  filtrerParStatut(statut: string): void {
    const actuel = this.filtres().status;
    void this.naviguer({
      ...this.filtres(),
      status: actuel === statut ? '' : statut,
      page: 1,
    });
  }

  reinitialiser(): void {
    void this.naviguer(FILTRES_RETOURS_VIDES);
  }

  allerALaPage(page: number): void {
    void this.naviguer({ ...this.filtres(), page });
  }

  passages(statut: string): readonly FeedbackStatus[] {
    return statutsAtteignables(statut);
  }

  nomStatut(status: string): string {
    return libelleStatutRetour(status);
  }

  nomType(kind: string): string {
    return libelleType(kind);
  }

  nomGravite(severity: string): string {
    return libelleGravite(severity);
  }

  /** Le libellé porte le sens ; la couleur ne fait que l'appuyer. */
  classeStatut(status: string): string {
    const socle = 'shrink-0 rounded-full px-2 py-0.5 text-xs';
    if (status === 'resolu') return `${socle} bg-ok-surface text-ok-content`;
    if (status === 'rejete') return `${socle} bg-danger-surface text-danger-content`;
    if (status === 'en_cours') return `${socle} bg-info-surface text-info-content`;
    if (status === 'accepte') return `${socle} bg-warn-surface text-warn-content`;
    return `${socle} bg-sunken text-content-muted`;
  }

  private naviguer(filtres: FeedbackFilterState): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsDepuisFiltresRetours(filtres),
    });
  }
}
