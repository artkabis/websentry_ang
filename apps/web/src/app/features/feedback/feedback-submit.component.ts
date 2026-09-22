import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { FeedbackApi } from '../../core/feedback/feedback.api';
import {
  BROUILLON_RETOUR_VIDE,
  GRAVITES,
  libelleGravite,
  libelleType,
  problemesRetour,
  retourValide,
  TYPES,
  type BrouillonRetour,
} from './feedback-form';

/**
 * Dépôt d'un retour.
 *
 * Le formulaire est court, et c'est le point : une équipe qualité qui enchaîne
 * les audits ne signale que si signaler coûte moins cher que contourner.
 * Le contexte — l'écran d'où l'on vient — est CAPTURÉ plutôt que redemandé.
 */
@Component({
  selector: 'ws-feedback-submit',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-2xl px-4 py-10">
      <nav class="text-sm" aria-label="Fil d'Ariane">
        <a routerLink="/retours" class="text-brand-text hover:underline">Retours</a>
        <span class="mx-2 text-content-subtle" aria-hidden="true">/</span>
        <span class="text-content-muted">Nouveau retour</span>
      </nav>

      <h1 class="mt-2 text-2xl font-semibold text-content">Signaler quelque chose</h1>
      <p class="mt-1 text-sm text-content-subtle">
        Une anomalie, une idée, une question. Quatre champs, et c'est tout.
      </p>

      @if (erreur(); as message) {
        <div class="mt-4 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
        </div>
      }

      <form class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line" (ngSubmit)="envoyer()">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="text-xs font-medium text-content-muted">Type</span>
            <select
              name="kind"
              [ngModel]="brouillon().kind"
              (ngModelChange)="maj({ kind: $event })"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              @for (type of types; track type) {
                <option [value]="type">{{ nomType(type) }}</option>
              }
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Gravité</span>
            <select
              name="severity"
              [ngModel]="brouillon().severity"
              (ngModelChange)="maj({ severity: $event })"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              @for (gravite of gravites; track gravite) {
                <option [value]="gravite">{{ nomGravite(gravite) }}</option>
              }
            </select>
            <span class="mt-1 block text-xs text-content-subtle">
              Votre appréciation ; elle pourra être ajustée au traitement.
            </span>
          </label>
        </div>

        <label class="mt-4 block">
          <span class="text-xs font-medium text-content-muted">Titre</span>
          <input
            type="text"
            name="title"
            required
            [ngModel]="brouillon().title"
            (ngModelChange)="maj({ title: $event })"
            placeholder="En une phrase, ce qui ne va pas"
            class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
          />
        </label>

        <label class="mt-4 block">
          <span class="text-xs font-medium text-content-muted">Description</span>
          <textarea
            name="body"
            rows="7"
            required
            [ngModel]="brouillon().body"
            (ngModelChange)="maj({ body: $event })"
            placeholder="Ce que vous avez fait, ce que vous attendiez, ce qui s'est passé."
            class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
          ></textarea>
          <span class="mt-1 block text-xs text-content-subtle">
            {{ restant() }} caractères restants.
          </span>
        </label>

        @if (contexteUtile()) {
          <p class="mt-4 rounded-lg bg-sunken p-3 text-xs text-content-muted">
            L'écran d'où vous venez sera joint automatiquement :
            <code>{{ depuis() }}</code>
          </p>
        }

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
            [disabled]="!envoyable()"
            class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            @if (envoi()) {
              Envoi…
            } @else {
              Envoyer
            }
          </button>
          <a
            routerLink="/retours"
            class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken"
          >
            Annuler
          </a>
        </div>
      </form>
    </main>
  `,
})
export class FeedbackSubmitComponent {
  private readonly api = inject(FeedbackApi);
  private readonly router = inject(Router);

  /** Route d'où vient l'utilisateur, jointe au retour. */
  readonly depuis = input<string>();
  readonly gamme = input<string>();

  readonly types = TYPES;
  readonly gravites = GRAVITES;

  readonly brouillon = signal<BrouillonRetour>(BROUILLON_RETOUR_VIDE);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly contexte = computed(() => ({
    route: this.depuis() ?? null,
    targetUrl: null,
    gamme: this.gamme() ?? null,
  }));

  readonly contexteUtile = computed(() => this.depuis() !== undefined && this.depuis() !== '');

  readonly problemes = computed(() => {
    // Tant que rien n'est saisi, on n'affiche AUCUN reproche : signaler « titre
    // trop court » sur un champ vierge est une alarme permanente et inutile.
    const brouillon = this.brouillon();
    if (brouillon.title === '' && brouillon.body === '') return [];
    return problemesRetour(brouillon, this.contexte());
  });

  readonly restant = computed(() => 5000 - this.brouillon().body.trim().length);

  readonly envoyable = computed(
    () => !this.envoi() && retourValide(this.brouillon(), this.contexte()) !== null,
  );

  maj(partiel: Partial<BrouillonRetour>): void {
    this.brouillon.update(actuel => ({ ...actuel, ...partiel }));
  }

  async envoyer(): Promise<void> {
    const charge = retourValide(this.brouillon(), this.contexte());
    if (!charge || this.envoi()) return;

    this.envoi.set(true);
    this.erreur.set(null);
    try {
      const cree = await this.api.create(charge);
      // On mène au retour déposé plutôt qu'à un simple message : l'auteur voit
      // ce qui a été enregistré, et peut en suivre le traitement.
      await this.router.navigate(['/retours'], { queryParams: { ouvert: cree.id } });
    } catch (err) {
      this.erreur.set(
        messageDErreur(err, 'L’envoi a échoué. Votre retour n’a pas été enregistré.'),
      );
    } finally {
      this.envoi.set(false);
    }
  }

  nomType(kind: string): string {
    return libelleType(kind);
  }

  nomGravite(severity: string): string {
    return libelleGravite(severity);
  }
}

/** Message de l'API quand elle en donne un, repli sinon. */
function messageDErreur(err: unknown, repli: string): string {
  const reponse = err as { error?: { message?: unknown } };
  const message = reponse.error?.message;
  if (typeof message === 'string' && message.trim() !== '') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return repli;
}
