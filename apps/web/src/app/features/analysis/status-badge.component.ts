import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { CheckStatus } from '@websentry/shared';

/** Libellés des statuts — la couleur ne porte JAMAIS l'information seule. */
const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: 'Conforme',
  info: 'Pour information',
  warning: 'À surveiller',
  fail: 'En échec',
  na: 'Non applicable',
};

const STATUS_CLASSES: Readonly<Record<CheckStatus, string>> = {
  pass: 'bg-emerald-100 text-emerald-800',
  info: 'bg-sky-100 text-sky-800',
  warning: 'bg-amber-100 text-amber-800',
  fail: 'bg-red-100 text-red-800',
  na: 'bg-slate-100 text-slate-500',
};

/**
 * Pastille de statut.
 *
 * Elle porte TOUJOURS son libellé en toutes lettres, jamais une couleur seule :
 * une pastille rouge est invisible pour un lecteur d'écran et indistinguable
 * d'une verte pour une part notable des utilisateurs (WCAG 1.4.1).
 */
@Component({
  selector: 'ws-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <span [class]="classes()">{{ label() }}</span> `,
})
export class StatusBadgeComponent {
  readonly status = input.required<CheckStatus>();

  readonly label = computed(() => STATUS_LABELS[this.status()]);

  readonly classes = computed(
    () =>
      `inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[this.status()]}`,
  );
}
