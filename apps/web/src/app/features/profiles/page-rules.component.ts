import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import type { CheckMeta, PageRule } from '@websentry/shared';
import { TokenListComponent } from '../../shared/token-list.component';

/**
 * Seuils d'une règle, vus à PLAT.
 *
 * Le schéma les imbrique par groupe (`content`, `h1`, `h2`) ; l'écran, lui, ne
 * manipule qu'un couple groupe/champ. Une conversion unique et nommée vaut
 * mieux que six accesseurs typés qui ne diraient rien de plus.
 */
type Seuils = Record<string, Record<string, number>>;

function seuilsDe(rule: PageRule): Seuils {
  return rule.settings ?? {};
}

/**
 * Règles par page — exceptions au profil d'une gamme.
 *
 * Un profil vaut pour tout un site, mais une page de contact n'a pas à
 * contenir trois cents mots et une page légale n'a pas à porter de CTA. Une
 * règle décrit donc UN gabarit : à quelles adresses il correspond, quels
 * critères n'y ont pas de sens, et quels seuils y sont différents.
 *
 * Les champs numériques laissés VIDES ne sont pas des zéros : ils signifient
 * « pas de surcharge », et le seuil du profil s'applique. Confondre les deux
 * mettrait toutes les pages de contact à zéro mot exigé sans que personne ne
 * l'ait demandé.
 */
@Component({
  selector: 'ws-page-rules',
  standalone: true,
  imports: [TokenListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rules().length === 0) {
      <p class="mt-4 text-sm text-content-subtle">
        Aucune règle : le profil s'applique tel quel à toutes les pages du site.
      </p>
    }

    <ul class="mt-4 space-y-4">
      @for (rule of rules(); track $index; let iRegle = $index) {
        <li class="rounded-xl bg-sunken p-4 ring-1 ring-line">
          <div class="flex items-end gap-2">
            <label class="block flex-1 text-sm">
              <span class="text-content-muted">Nom de la règle</span>
              <input
                type="text"
                [value]="rule.label"
                [disabled]="disabled()"
                maxlength="120"
                [attr.aria-label]="'Nom de la règle ' + (iRegle + 1)"
                (input)="setLabel(iRegle, $any($event.target).value)"
                class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm
                       text-content focus:border-brand focus:outline-none
                       focus:ring-2 focus:ring-brand/30 disabled:bg-sunken"
              />
            </label>
            <button
              type="button"
              [disabled]="disabled()"
              (click)="removeRule(iRegle)"
              [attr.aria-label]="'Retirer la règle ' + (rule.label || iRegle + 1)"
              class="rounded-lg border border-danger-content px-3 py-2 text-sm text-danger-content
                     hover:bg-danger-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              Retirer
            </button>
          </div>

          @if (rule.label.trim().length === 0) {
            <p role="alert" class="mt-1 text-xs text-danger-content">
              Nommez la règle : c'est ce nom qui l'identifie dans le rapport.
            </p>
          }

          <ws-token-list
            [items]="patternsOf(iRegle)"
            (itemsChange)="setPatterns(iRegle, $event)"
            addLabel="Motif d'adresse"
            emptyLabel="Aucun motif — cette règle ne s'appliquera à aucune page."
            [disabled]="disabled()"
            [maxItems]="200"
            [maxLength]="500"
          />
          <p class="mt-1 text-xs text-content-subtle">
            Un motif est cherché dans les SEGMENTS du chemin : « contact » retient
            <code>/nous-contacter</code> mais pas <code>/prise-de-contact/equipe</code>.
            <code>/</code> ne désigne que l'accueil.
          </p>

          <fieldset class="mt-4" [disabled]="disabled()">
            <legend class="text-sm text-content-muted">
              Critères sans objet sur ces pages ({{ rule.disabledChecks?.length ?? 0 }})
            </legend>
            <div class="mt-2 grid gap-1 sm:grid-cols-2">
              @for (check of checks(); track check.id) {
                <label class="flex items-center gap-2 text-xs text-content-muted">
                  <input
                    type="checkbox"
                    [checked]="isDisabled(iRegle, check.id)"
                    [disabled]="disabled()"
                    (change)="toggleCheck(iRegle, check.id)"
                    [attr.aria-label]="check.title + ' — règle ' + (rule.label || iRegle + 1)"
                    class="rounded border-field"
                  />
                  {{ check.title }}
                </label>
              }
            </div>
          </fieldset>

          <fieldset class="mt-4" [disabled]="disabled()">
            <legend class="text-sm text-content-muted">Seuils propres à ces pages</legend>
            <p class="mt-1 text-xs text-content-subtle">Un champ vide garde le seuil du profil.</p>
            <div class="mt-2 grid gap-3 sm:grid-cols-3">
              @for (champ of NUMERIC_FIELDS; track champ.key) {
                <label class="block text-xs">
                  <span class="text-content-muted">{{ champ.label }}</span>
                  <input
                    type="number"
                    [value]="numeric(iRegle, champ.key)"
                    [disabled]="disabled()"
                    [min]="champ.min"
                    [max]="champ.max"
                    [attr.aria-label]="champ.label + ' — règle ' + (rule.label || iRegle + 1)"
                    (input)="setNumeric(iRegle, champ.key, $any($event.target).value)"
                    class="mt-1 w-full rounded-lg border border-field bg-panel px-2 py-1.5 text-sm
                           text-content focus:border-brand focus:outline-none
                           focus:ring-2 focus:ring-brand/30 disabled:bg-sunken"
                  />
                </label>
              }
            </div>
          </fieldset>
        </li>
      }
    </ul>

    <button
      type="button"
      [disabled]="disabled() || rules().length >= MAX_RULES"
      (click)="addRule()"
      class="mt-4 rounded-lg border border-field px-3 py-2 text-sm text-content-muted
             hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60"
    >
      Ajouter une règle
    </button>
    @if (rules().length >= MAX_RULES) {
      <p class="mt-1 text-xs text-content-subtle">{{ MAX_RULES }} règles au plus.</p>
    }
  `,
})
export class PageRulesComponent {
  readonly rules = model.required<PageRule[]>();
  readonly checks = input.required<readonly CheckMeta[]>();
  readonly disabled = input(false);

  /** Plafond REPRIS du schéma partagé : l'API refuserait au-delà. */
  readonly MAX_RULES = 200;

  /**
   * Seuils surchargeables, et leurs bornes.
   *
   * Le chemin est plat (`content.minWords`) parce que la surcharge, elle, est
   * imbriquée : l'aplatir ici évite six accesseurs qui ne diraient rien de plus.
   */
  readonly NUMERIC_FIELDS = [
    { key: 'content.minWords', label: 'Mots — minimum', min: 0, max: 100_000 },
    { key: 'content.warningWords', label: 'Mots — avertissement', min: 0, max: 100_000 },
    { key: 'h1.minLength', label: 'H1 — minimum', min: 0, max: 10_000 },
    { key: 'h1.maxLength', label: 'H1 — maximum', min: 1, max: 10_000 },
    { key: 'h2.minLength', label: 'H2 — minimum', min: 0, max: 10_000 },
    { key: 'h2.maxLength', label: 'H2 — maximum', min: 1, max: 10_000 },
  ] as const;

  /** Règles dont le nom manque ou qui ne visent aucune page. */
  readonly incomplete = computed(
    () =>
      this.rules().filter(rule => rule.label.trim().length === 0 || rule.patterns.length === 0)
        .length,
  );

  patternsOf(index: number): string[] {
    return [...(this.rules()[index]?.patterns ?? [])];
  }

  isDisabled(index: number, checkId: string): boolean {
    return this.rules()[index]?.disabledChecks?.includes(checkId) ?? false;
  }

  numeric(index: number, key: string): string {
    const [groupe, champ] = key.split('.');
    const rule = this.rules()[index];
    const valeur = rule ? seuilsDe(rule)[groupe ?? '']?.[champ ?? ''] : undefined;
    return valeur === undefined ? '' : String(valeur);
  }

  addRule(): void {
    if (this.disabled() || this.rules().length >= this.MAX_RULES) return;
    this.rules.update(courant => [...courant, { label: '', patterns: [] }]);
  }

  removeRule(index: number): void {
    if (this.disabled()) return;
    this.rules.update(courant => courant.filter((_, i) => i !== index));
  }

  setLabel(index: number, label: string): void {
    this.patch(index, rule => ({ ...rule, label }));
  }

  setPatterns(index: number, patterns: string[]): void {
    this.patch(index, rule => ({ ...rule, patterns }));
  }

  toggleCheck(index: number, checkId: string): void {
    this.patch(index, rule => {
      const courant = rule.disabledChecks ?? [];
      const suivant = courant.includes(checkId)
        ? courant.filter(id => id !== checkId)
        : [...courant, checkId];
      // La clé DISPARAÎT quand la liste se vide : un tableau vide et une
      // absence ne se distinguent pas à la lecture, mais gonflent le profil.
      const { disabledChecks: _, ...reste } = rule;
      return suivant.length > 0 ? { ...reste, disabledChecks: suivant } : reste;
    });
  }

  setNumeric(index: number, key: string, brut: string): void {
    const [groupe, champ] = key.split('.');
    if (!groupe || !champ) return;

    this.patch(index, rule => {
      const seuils: Seuils = { ...seuilsDe(rule) };
      const actuel = { ...(seuils[groupe] ?? {}) };

      // Vide = PAS de surcharge. Un zéro serait un seuil, et un seuil à zéro
      // rend le critère inopérant au lieu de le laisser au profil.
      if (brut.trim() === '') delete actuel[champ];
      else {
        const valeur = Number(brut);
        if (!Number.isFinite(valeur)) return rule;
        actuel[champ] = Math.trunc(valeur);
      }

      if (Object.keys(actuel).length === 0) delete seuils[groupe];
      else seuils[groupe] = actuel;

      const { settings: _, ...reste } = rule;
      return Object.keys(seuils).length > 0 ? { ...reste, settings: seuils } : reste;
    });
  }

  private patch(index: number, muter: (rule: PageRule) => PageRule): void {
    if (this.disabled()) return;
    this.rules.update(courant => courant.map((rule, i) => (i === index ? muter(rule) : rule)));
  }
}
