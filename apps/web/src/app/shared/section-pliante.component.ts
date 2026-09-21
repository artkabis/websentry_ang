import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

/**
 * Section repliable d'un formulaire long.
 *
 * Replier n'est pas masquer : l'en-tête porte un RÉSUMÉ chiffré de ce qu'elle
 * contient — « 29 / 29 critères actifs », « 3 pondérations sur mesure » — de
 * sorte qu'on sache ce qu'on n'ouvre pas. Une section qui dirait seulement son
 * titre obligerait à l'ouvrir pour savoir si elle mérite d'être ouverte.
 *
 * Le pliage s'appuie sur `<details>` natif : le clavier, les lecteurs d'écran
 * et la recherche dans la page le connaissent déjà. Une version maison en
 * `<div>` avec `aria-expanded` reproduirait ce comportement — moins bien.
 *
 * L'état est retenu PAR SECTION : un profil se règle en plusieurs passes, et
 * refermer à chaque rechargement ce qu'on vient d'ouvrir ferait perdre
 * exactement le temps que ce composant est censé faire gagner.
 */
@Component({
  selector: 'ws-section-pliante',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details
      class="group rounded-xl bg-panel shadow-sm ring-1 ring-line"
      [open]="ouverte()"
      (toggle)="retenir($any($event.target).open)"
    >
      <summary
        class="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-6 py-4
               hover:bg-sunken"
      >
        <span class="min-w-0">
          <span class="block text-sm font-medium text-content">{{ titre() }}</span>
          <span class="block truncate text-xs text-content-subtle">{{ resume() }}</span>
        </span>
        <!--
          Le chevron est décoratif : l'état plié/déplié est déjà annoncé par
          l'élément de dépliage lui-même. Le redire en texte le ferait
          entendre deux fois.
        -->
        <span aria-hidden="true" class="shrink-0 text-content-subtle group-open:rotate-90">›</span>
      </summary>
      <div class="border-t border-line px-6 pb-6 pt-4">
        <ng-content />
      </div>
    </details>
  `,
})
export class SectionPlianteComponent {
  private readonly document = inject(DOCUMENT);

  readonly titre = input.required<string>();
  /** Ce que la section contient, en un coup d'œil, même repliée. */
  readonly resume = input('');
  /** Clé de mémorisation ; sans elle, l'état n'est pas retenu. */
  readonly cle = input<string | null>(null);
  readonly ouvertParDefaut = input(false);

  private readonly _ouverte = signal<boolean | null>(null);

  ouverte(): boolean {
    return this._ouverte() ?? this.restaurer();
  }

  retenir(ouverte: boolean): void {
    this._ouverte.set(ouverte);
    const cle = this.cle();
    if (!cle) return;
    try {
      this.document.defaultView?.localStorage.setItem(
        `websentry.section.${cle}`,
        ouverte ? '1' : '0',
      );
    } catch {
      // Stockage refusé : l'état vaut pour la session en cours. Perdre un
      // pliage est sans conséquence, faire tomber l'écran en aurait une.
    }
  }

  private restaurer(): boolean {
    const cle = this.cle();
    if (!cle) return this.ouvertParDefaut();
    try {
      const garde = this.document.defaultView?.localStorage.getItem(`websentry.section.${cle}`);
      return garde === null || garde === undefined ? this.ouvertParDefaut() : garde === '1';
    } catch {
      return this.ouvertParDefaut();
    }
  }
}
