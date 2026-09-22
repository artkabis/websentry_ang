import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { UserSummary } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';
import { libelleRang, rangsAttribuables, refusPrevisible } from './user-filters';
import {
  BROUILLON_VIDE,
  brouillonDepuisCompte,
  creationValide,
  genererMotDePasse,
  modificationValide,
  problemesCreation,
  problemesModification,
  problemesMotDePasse,
  type BrouillonCompte,
} from './user-form';
import { UserPermissionsComponent } from './user-permissions.component';

/**
 * Fiche d'un compte — création et édition par le même écran.
 *
 * L'identifiant et le mot de passe ne sont demandés QU'À la création : le
 * premier ne se change pas, le second passe par une route distincte avec sa
 * propre trace d'audit (cf. `docs/DECISIONS.md` §40).
 *
 * Chaque action rend la main tout de suite — état en attente sur le contrôle
 * actionné, jamais un gel silencieux. Ce qui est destructeur se confirme ; ce
 * qui ne l'est pas (une suspension) s'annule en rebasculant le champ.
 */
@Component({
  selector: 'ws-user-editor',
  standalone: true,
  imports: [FormsModule, RouterLink, UserPermissionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-3xl px-4 py-10">
      <nav class="text-sm" aria-label="Fil d'Ariane">
        <a routerLink="/administration/comptes" class="text-brand-text hover:underline">
          Comptes
        </a>
        <span class="mx-2 text-content-subtle" aria-hidden="true">/</span>
        <span class="text-content-muted">{{ titre() }}</span>
      </nav>

      <h1 class="mt-2 text-2xl font-semibold text-content">{{ titre() }}</h1>

      <p role="status" aria-live="polite" class="mt-2 text-sm text-content-subtle">
        {{ messageEtat() }}
      </p>

      @if (erreur(); as message) {
        <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
        </div>
      }

      @if (chargement()) {
        <div class="mt-6 space-y-3" aria-hidden="true">
          <div class="h-32 animate-pulse rounded-xl bg-sunken"></div>
          <div class="h-32 animate-pulse rounded-xl bg-sunken"></div>
        </div>
      } @else if (introuvable()) {
        <div class="mt-6 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
          <p class="text-sm text-content-muted">Ce compte n'existe pas ou plus.</p>
          <a
            routerLink="/administration/comptes"
            class="mt-3 inline-block rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Revenir à la liste
          </a>
        </div>
      } @else {
        @if (refusModification(); as raison) {
          <!-- On peut atteindre cette fiche par son adresse directe : le refus
               s'explique ici, plutôt que d'attendre un 403 à l'enregistrement. -->
          <p role="alert" class="mt-6 rounded-lg bg-warn-surface p-4 text-sm text-warn-content">
            {{ raison }} Vous pouvez consulter cette fiche, pas la modifier.
          </p>
        }

        <!-- ── Identité et rang ──────────────────────────────────────────── -->
        <form
          class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line"
          (ngSubmit)="soumettre()"
        >
          <h2 class="text-base font-medium text-content">Identité</h2>

          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            @if (creation()) {
              <label class="block">
                <span class="text-xs font-medium text-content-muted">Identifiant</span>
                <input
                  type="text"
                  name="username"
                  autocomplete="username"
                  required
                  [ngModel]="brouillon().username"
                  (ngModelChange)="majBrouillon({ username: $event })"
                  class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
                />
                <span class="mt-1 block text-xs text-content-subtle">
                  Minuscules, chiffres, point, tiret ou souligné. Il ne se change pas ensuite.
                </span>
              </label>

              <label class="block">
                <span class="text-xs font-medium text-content-muted">Mot de passe</span>
                <div class="mt-1 flex gap-2">
                  <input
                    type="text"
                    name="password"
                    autocomplete="new-password"
                    required
                    [ngModel]="brouillon().password"
                    (ngModelChange)="majBrouillon({ password: $event })"
                    class="w-full rounded-lg border border-field bg-panel px-3 py-2 font-mono text-sm text-content"
                  />
                  <button
                    type="button"
                    (click)="genererPourCreation()"
                    class="shrink-0 rounded-lg border border-field px-3 py-2 text-sm text-content-muted hover:bg-sunken"
                  >
                    Générer
                  </button>
                </div>
                <span class="mt-1 block text-xs text-content-subtle">
                  Affiché en clair : il faut pouvoir le transmettre. Il ne sera plus jamais visible.
                </span>
              </label>
            } @else {
              <p class="sm:col-span-2 text-sm text-content-muted">
                Identifiant : <span class="font-medium text-content">{{ compte()?.username }}</span>
              </p>
            }

            <label class="block">
              <span class="text-xs font-medium text-content-muted">Nom affiché</span>
              <input
                type="text"
                name="displayName"
                [ngModel]="brouillon().displayName"
                (ngModelChange)="majBrouillon({ displayName: $event })"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
              />
            </label>

            <label class="block">
              <span class="text-xs font-medium text-content-muted">Courriel</span>
              <input
                type="email"
                name="email"
                autocomplete="email"
                [ngModel]="brouillon().email"
                (ngModelChange)="majBrouillon({ email: $event })"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
              />
            </label>

            <label class="block">
              <span class="text-xs font-medium text-content-muted">Rang</span>
              <select
                name="rank"
                [ngModel]="brouillon().rank"
                (ngModelChange)="majBrouillon({ rank: +$event })"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
              >
                <option [ngValue]="null">Choisir…</option>
                @for (rang of rangsPossibles(); track rang) {
                  <option [ngValue]="rang">{{ nomRang(rang) }}</option>
                }
              </select>
              <span class="mt-1 block text-xs text-content-subtle">
                Vous ne pouvez pas attribuer un rang supérieur ou égal au vôtre.
              </span>
            </label>

            @if (!creation()) {
              <label class="block">
                <span class="text-xs font-medium text-content-muted">Statut</span>
                <select
                  name="status"
                  [ngModel]="brouillon().status"
                  (ngModelChange)="majBrouillon({ status: $event })"
                  class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
                >
                  <option value="active">Actif</option>
                  <option value="suspended">Suspendu</option>
                  <option value="pending">En attente</option>
                </select>
                <span class="mt-1 block text-xs text-content-subtle">
                  Suspendre ferme immédiatement les sessions ouvertes. C'est réversible.
                </span>
              </label>
            }
          </div>

          @if (problemes().length > 0) {
            <ul class="mt-4 space-y-1" role="alert">
              @for (probleme of problemes(); track probleme) {
                <li class="text-sm text-danger-content">{{ probleme }}</li>
              }
            </ul>
          }

          <div class="mt-4 flex items-center gap-2">
            <button
              type="submit"
              [disabled]="!soumettable()"
              class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              @if (enregistrement()) {
                Enregistrement…
              } @else if (creation()) {
                Créer le compte
              } @else {
                Enregistrer
              }
            </button>
            <a
              routerLink="/administration/comptes"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken"
            >
              Annuler
            </a>
            @if (!creation() && !modifie()) {
              <span class="text-xs text-content-subtle">Aucune modification à enregistrer.</span>
            }
          </div>
        </form>

        @if (!creation() && compte(); as courant) {
          <!-- ── Mot de passe ────────────────────────────────────────────── -->
          <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
            <h2 class="text-base font-medium text-content">Réinitialiser le mot de passe</h2>
            <p class="mt-1 text-sm text-content-subtle">
              Les sessions ouvertes de ce compte seront fermées. L'ancien mot de passe cesse
              aussitôt de valoir.
            </p>

            @if (motDePasseChange()) {
              <p role="status" class="mt-3 rounded-lg bg-ok-surface p-3 text-sm text-ok-content">
                Mot de passe remplacé. Transmettez-le maintenant : il n'est plus affiché ailleurs.
              </p>
            }

            <form class="mt-3" (ngSubmit)="reinitialiser(courant.id)">
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block">
                  <span class="text-xs font-medium text-content-muted">Nouveau mot de passe</span>
                  <div class="mt-1 flex gap-2">
                    <input
                      type="text"
                      name="nouveauMotDePasse"
                      autocomplete="new-password"
                      [ngModel]="nouveauMotDePasse()"
                      (ngModelChange)="nouveauMotDePasse.set($event)"
                      class="w-full rounded-lg border border-field bg-panel px-3 py-2 font-mono text-sm text-content"
                    />
                    <button
                      type="button"
                      (click)="genererPourReinitialisation()"
                      class="shrink-0 rounded-lg border border-field px-3 py-2 text-sm text-content-muted hover:bg-sunken"
                    >
                      Générer
                    </button>
                  </div>
                </label>

                <label class="block">
                  <span class="text-xs font-medium text-content-muted">Confirmation</span>
                  <input
                    type="text"
                    name="confirmation"
                    autocomplete="new-password"
                    [ngModel]="confirmation()"
                    (ngModelChange)="confirmation.set($event)"
                    class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 font-mono text-sm text-content"
                  />
                </label>
              </div>

              @if (problemesMdp().length > 0) {
                <ul class="mt-3 space-y-1" role="alert">
                  @for (probleme of problemesMdp(); track probleme) {
                    <li class="text-sm text-danger-content">{{ probleme }}</li>
                  }
                </ul>
              }

              <button
                type="submit"
                [disabled]="!motDePasseSoumettable()"
                class="mt-3 rounded-lg bg-warn-solid px-4 py-2 text-sm font-medium text-on-accent hover:bg-warn-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                @if (reinitialisation()) {
                  Réinitialisation…
                } @else {
                  Réinitialiser
                }
              </button>
            </form>
          </section>

          <!-- ── Permissions ─────────────────────────────────────────────── -->
          <div class="mt-6">
            <ws-user-permissions [userId]="courant.id" [modifiable]="peutEcrire()" />
          </div>

          <!-- ── Suppression ─────────────────────────────────────────────── -->
          @if (peutSupprimer()) {
            <section class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-danger-content/30">
              <h2 class="text-base font-medium text-danger-content">Supprimer ce compte</h2>
              <p class="mt-1 text-sm text-content-subtle">
                Définitif. L'historique des scans lancés par ce compte est conservé.
              </p>

              @if (!confirmationSuppression()) {
                <button
                  type="button"
                  (click)="confirmationSuppression.set(true)"
                  class="mt-3 rounded-lg border border-danger-content px-4 py-2 text-sm font-medium text-danger-content hover:bg-danger-surface"
                >
                  Supprimer…
                </button>
              } @else {
                <div class="mt-3 rounded-lg bg-danger-surface p-4">
                  <p class="text-sm text-danger-content">
                    Supprimer définitivement <strong>{{ courant.username }}</strong> ?
                  </p>
                  <div class="mt-3 flex gap-2">
                    <button
                      type="button"
                      (click)="supprimer(courant.id)"
                      [disabled]="suppression()"
                      class="rounded-lg bg-danger-solid px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
                    >
                      @if (suppression()) {
                        Suppression…
                      } @else {
                        Oui, supprimer
                      }
                    </button>
                    <button
                      type="button"
                      (click)="confirmationSuppression.set(false)"
                      class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-panel"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              }
            </section>
          }
        }
      }
    </main>
  `,
})
export class UserEditorComponent {
  private readonly api = inject(UsersApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Absent en création — la route `/comptes/nouveau` ne porte pas de paramètre. */
  readonly id = input<string>();

  readonly compte = signal<UserSummary | null>(null);
  readonly brouillon = signal<BrouillonCompte>(BROUILLON_VIDE);
  readonly chargement = signal(false);
  readonly introuvable = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly enregistrement = signal(false);

  readonly nouveauMotDePasse = signal('');
  readonly confirmation = signal('');
  readonly reinitialisation = signal(false);
  readonly motDePasseChange = signal(false);

  readonly confirmationSuppression = signal(false);
  readonly suppression = signal(false);

  readonly creation = computed(() => this.id() === undefined);

  readonly titre = computed(() => {
    if (this.creation()) return 'Nouveau compte';
    const courant = this.compte();
    return courant ? `Compte ${courant.username}` : 'Compte';
  });

  readonly peutEcrire = computed(() => this.auth.hasPermission('users:write'));
  readonly peutSupprimer = computed(
    () => this.auth.hasPermission('users:delete') && this.refusSuppression() === null,
  );

  readonly rangsPossibles = computed(() => rangsAttribuables(this.auth.rank()));

  readonly problemes = computed(() => {
    const courant = this.compte();
    if (this.creation()) return problemesCreation(this.brouillon());
    return courant ? problemesModification(courant, this.brouillon()) : [];
  });

  readonly modifie = computed(() => {
    const courant = this.compte();
    return courant !== null && modificationValide(courant, this.brouillon()) !== null;
  });

  readonly refusModification = computed(() => this.refus('modifier'));
  readonly refusSuppression = computed(() => this.refus('supprimer'));

  readonly soumettable = computed(() => {
    if (this.enregistrement() || !this.peutEcrire()) return false;
    if (this.refusModification() !== null) return false;
    if (this.creation()) return creationValide(this.brouillon()) !== null;
    return this.modifie() && this.problemes().length === 0;
  });

  readonly problemesMdp = computed(() =>
    this.nouveauMotDePasse() === ''
      ? []
      : problemesMotDePasse(this.nouveauMotDePasse(), this.confirmation()),
  );

  readonly motDePasseSoumettable = computed(
    () =>
      !this.reinitialisation() &&
      this.peutEcrire() &&
      this.refus('motDePasse') === null &&
      this.nouveauMotDePasse() !== '' &&
      this.confirmation() !== '' &&
      this.problemesMdp().length === 0,
  );

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement du compte…';
    if (this.introuvable()) return 'Compte introuvable.';
    if (this.creation()) return 'Renseignez l’identité du nouveau compte.';
    return 'Fiche chargée.';
  });

  constructor() {
    effect(() => {
      const id = this.id();
      if (id === undefined) {
        this.compte.set(null);
        this.brouillon.set(BROUILLON_VIDE);
        return;
      }
      void this.charger(id);
    });
  }

  async charger(id: string): Promise<void> {
    this.chargement.set(true);
    this.introuvable.set(false);
    this.erreur.set(null);
    try {
      const courant = await this.api.get(id);
      this.compte.set(courant);
      this.brouillon.set(brouillonDepuisCompte(courant));
    } catch {
      this.introuvable.set(true);
      this.compte.set(null);
    } finally {
      this.chargement.set(false);
    }
  }

  majBrouillon(partiel: Partial<BrouillonCompte>): void {
    this.brouillon.update(actuel => ({ ...actuel, ...partiel }));
  }

  genererPourCreation(): void {
    this.majBrouillon({ password: genererMotDePasse() });
  }

  genererPourReinitialisation(): void {
    const propose = genererMotDePasse();
    // La confirmation est remplie avec : elle protège de la faute de frappe,
    // pas d'un mot de passe qu'on n'a jamais tapé.
    this.nouveauMotDePasse.set(propose);
    this.confirmation.set(propose);
  }

  async soumettre(): Promise<void> {
    if (!this.soumettable()) return;
    this.enregistrement.set(true);
    this.erreur.set(null);

    try {
      if (this.creation()) {
        const charge = creationValide(this.brouillon());
        if (!charge) return;
        const cree = await this.api.create(charge);
        await this.router.navigate(['/administration/comptes', cree.id]);
        return;
      }

      const courant = this.compte();
      const diff = courant ? modificationValide(courant, this.brouillon()) : null;
      if (!courant || !diff) return;

      const majour = await this.api.update(courant.id, diff);
      this.compte.set(majour);
      this.brouillon.set(brouillonDepuisCompte(majour));
    } catch (err) {
      this.erreur.set(messageDErreur(err, 'L’enregistrement a échoué. Rien n’a été modifié.'));
    } finally {
      this.enregistrement.set(false);
    }
  }

  async reinitialiser(id: string): Promise<void> {
    if (!this.motDePasseSoumettable()) return;
    this.reinitialisation.set(true);
    this.erreur.set(null);
    this.motDePasseChange.set(false);

    try {
      await this.api.resetPassword(id, this.nouveauMotDePasse());
      this.motDePasseChange.set(true);
      this.confirmation.set('');
    } catch (err) {
      this.erreur.set(
        messageDErreur(err, 'La réinitialisation a échoué. Le mot de passe est inchangé.'),
      );
    } finally {
      this.reinitialisation.set(false);
    }
  }

  async supprimer(id: string): Promise<void> {
    this.suppression.set(true);
    this.erreur.set(null);
    try {
      await this.api.remove(id);
      await this.router.navigate(['/administration/comptes']);
    } catch (err) {
      this.erreur.set(messageDErreur(err, 'La suppression a échoué. Le compte existe toujours.'));
      this.confirmationSuppression.set(false);
    } finally {
      this.suppression.set(false);
    }
  }

  nomRang(rank: number): string {
    return libelleRang(rank);
  }

  /** Raison pour laquelle l'API refuserait — affichée avant le clic, pas après. */
  refus(geste: 'modifier' | 'supprimer' | 'motDePasse'): string | null {
    const courant = this.compte();
    const utilisateur = this.auth.user();
    if (!courant || !utilisateur) return null;
    return refusPrevisible(courant, { id: utilisateur.id ?? '', rank: utilisateur.rank }, geste);
  }
}

/**
 * Message de l'API quand elle en donne un, repli sinon.
 *
 * Les garde-fous du service rendent des messages PRÉCIS — « c'est le dernier
 * compte d'administration actif » — que l'interface ne peut pas reconstituer :
 * elle ignore combien d'administrateurs existent. Les reprendre tels quels vaut
 * mieux qu'un « échec » générique.
 */
function messageDErreur(err: unknown, repli: string): string {
  const reponse = err as { error?: { message?: unknown }; status?: number };
  const message = reponse.error?.message;
  if (typeof message === 'string' && message.trim() !== '') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return repli;
}
