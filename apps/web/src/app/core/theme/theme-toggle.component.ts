import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ThemeService, type ThemePreference } from './theme.service';

/**
 * Choix de l'apparence — trois états, exclusifs.
 *
 * Un bouton qui fait défiler les valeurs serait plus compact, mais il oblige à
 * essayer pour savoir : rien n'annonce où mène le prochain clic, et un lecteur
 * d'écran n'énonce qu'« Apparence ». Trois boutons radio disent l'état courant
 * ET les possibilités, et le clavier les parcourt nativement par les flèches.
 */
@Component({
  selector: 'ws-theme-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="flex items-center gap-0.5 rounded-lg bg-sunken p-0.5">
      <legend class="sr-only">Apparence</legend>
      @for (choix of choices; track choix.value) {
        <label
          class="relative cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium
                 text-content-subtle hover:text-content
                 has-checked:bg-panel has-checked:text-content has-checked:shadow-sm
                 has-focus-visible:outline-2 has-focus-visible:outline-offset-2
                 has-focus-visible:outline-brand-text"
        >
          <!--
            La case couvre toute la pastille plutôt que d'être réduite à un
            point invisible : la cible du pointeur est alors celle qu'on voit,
            et elle satisfait la taille minimale (WCAG 2.5.8). L'opacité nulle
            laisse le contrôle focusable et annonçable — contrairement à un
            affichage supprimé, qui le retirerait purement et simplement.
          -->
          <input
            type="radio"
            name="apparence"
            class="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
            [value]="choix.value"
            [checked]="theme.preference() === choix.value"
            (change)="theme.set(choix.value)"
          />
          {{ choix.label }}
        </label>
      }
    </fieldset>
  `,
})
export class ThemeToggleComponent {
  readonly theme = inject(ThemeService);

  readonly choices: readonly { value: ThemePreference; label: string }[] = [
    { value: 'clair', label: 'Clair' },
    { value: 'sombre', label: 'Sombre' },
    { value: 'systeme', label: 'Système' },
  ];
}
