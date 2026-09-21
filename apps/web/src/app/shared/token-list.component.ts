import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';

/**
 * Édition d'une liste de valeurs courtes — mots exclus, domaines exclus.
 *
 * Une zone de texte libre séparée par des virgules serait plus vite écrite,
 * mais elle reporte sur l'utilisateur tout ce qu'une liste doit garantir :
 * qu'une valeur n'y figure pas deux fois, qu'aucune n'est vide, que le
 * plafond du schéma est respecté. Ici chaque valeur existe comme un élément
 * qu'on retire d'un geste, et les refus sont expliqués au moment de la saisie.
 */
@Component({
  selector: 'ws-token-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mt-4">
      <div class="flex items-end gap-2">
        <label class="block flex-1 text-sm">
          <span class="text-content-muted">{{ addLabel() }}</span>
          <input
            type="text"
            [value]="draft()"
            [disabled]="disabled()"
            [attr.maxlength]="maxLength()"
            [attr.aria-describedby]="disabled() ? null : feedbackId"
            (input)="draft.set($any($event.target).value)"
            (keydown.enter)="$event.preventDefault(); add()"
            class="mt-1 w-full rounded-lg border border-field px-3 py-2 text-sm
                   focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30
                   disabled:bg-sunken"
          />
        </label>
        <!--
          Le nom accessible porte CE QU'ON AJOUTE : deux listes sur un même
          écran donneraient sinon deux boutons « Ajouter » indiscernables dans
          la liste des contrôles d'un lecteur d'écran.
        -->
        <button
          type="button"
          [disabled]="disabled()"
          (click)="add()"
          [attr.aria-label]="'Ajouter : ' + addLabel()"
          class="rounded-lg border border-field px-3 py-2 text-sm text-content-muted
                 hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60"
        >
          Ajouter
        </button>
      </div>

      <!--
        Le compte est du texte ordinaire ; seul le REFUS est annoncé. Placer le
        compte dans une région vivante le ferait relire à chaque ajout, et
        noierait le message qui, lui, demande une correction.
      -->
      @if (refus(); as raison) {
        <p [id]="feedbackId" role="alert" class="mt-1 text-xs text-danger-content">{{ raison }}</p>
      } @else {
        <p [id]="feedbackId" class="mt-1 text-xs text-content-subtle">
          {{ items().length }} sur {{ maxItems() }} au plus
        </p>
      }

      @if (items().length === 0) {
        <p class="mt-3 text-sm text-content-subtle">{{ emptyLabel() }}</p>
      } @else {
        <ul class="mt-3 flex flex-wrap gap-1.5">
          @for (item of items(); track item) {
            <li
              class="inline-flex items-center gap-1 rounded-full bg-sunken py-0.5 pl-2.5 pr-1
                     text-xs text-content-muted"
            >
              <span>{{ item }}</span>
              <button
                type="button"
                [disabled]="disabled()"
                (click)="remove(item)"
                [attr.aria-label]="'Retirer ' + item"
                class="rounded-full px-1 text-content-subtle hover:bg-panel hover:text-danger-content
                       disabled:cursor-not-allowed disabled:opacity-60"
              >
                ×
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class TokenListComponent {
  /** Valeurs éditées — liaison à double sens avec le composant parent. */
  readonly items = model.required<string[]>();

  readonly addLabel = input.required<string>();
  readonly emptyLabel = input('Aucune valeur.');
  readonly disabled = input(false);
  /** Plafonds REPRIS du schéma partagé : l'API refuserait au-delà. */
  readonly maxItems = input(1000);
  readonly maxLength = input(100);
  /** Normalisation appliquée avant comparaison et stockage. */
  readonly normalise = input<(valeur: string) => string>(v => v.trim().toLowerCase());

  readonly draft = signal('');
  private readonly _refus = signal<string | null>(null);
  readonly refus = computed(() => this._refus());

  /** Un identifiant par instance : plusieurs listes cohabitent sur un écran. */
  readonly feedbackId = `ws-token-list-${Math.random().toString(36).slice(2, 9)}`;

  add(): void {
    if (this.disabled()) return;
    const valeur = this.normalise()(this.draft());

    if (!valeur) {
      this._refus.set('Saisissez une valeur.');
      return;
    }
    if (valeur.length > this.maxLength()) {
      this._refus.set(`Trop long : ${this.maxLength()} caractères au plus.`);
      return;
    }
    if (this.items().includes(valeur)) {
      // Dire « déjà présente » plutôt que d'ajouter en silence : sans cela,
      // l'utilisateur croit avoir ajouté et cherche où sa valeur est passée.
      this._refus.set(`« ${valeur} » figure déjà dans la liste.`);
      return;
    }
    if (this.items().length >= this.maxItems()) {
      this._refus.set(`Liste pleine : ${this.maxItems()} valeurs au plus.`);
      return;
    }

    this.items.update(courant => [...courant, valeur]);
    this.draft.set('');
    this._refus.set(null);
  }

  remove(valeur: string): void {
    if (this.disabled()) return;
    this.items.update(courant => courant.filter(item => item !== valeur));
    this._refus.set(null);
  }
}
