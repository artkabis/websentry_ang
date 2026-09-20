import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SCORE_GOOD, SCORE_WARNING } from './report-view';

/** Circonférence du cercle de progression — rayon 42, soit 2πr. */
const CIRCUMFERENCE = 2 * Math.PI * 42;

/**
 * Cadran de score.
 *
 * Un arc plutôt qu'un simple nombre : l'œil situe une proportion bien plus vite
 * qu'il ne compare deux chiffres. Le nombre reste au centre — l'arc ne remplace
 * pas la valeur, il la situe.
 *
 * L'arc est marqué `aria-hidden` et la valeur exposée par un `role="img"`
 * porteur d'un libellé complet : un lecteur d'écran annonce « score 4,2 sur 5,
 * page conforme », jamais une suite de coordonnées SVG.
 */
@Component({
  selector: 'ws-score-dial',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="relative inline-flex size-28 items-center justify-center"
      role="img"
      [attr.aria-label]="ariaLabel()"
    >
      <svg viewBox="0 0 100 100" class="size-28 -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r="42" fill="none" stroke-width="8" class="stroke-slate-200" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke-width="8"
          stroke-linecap="round"
          [attr.stroke-dasharray]="circumference"
          [attr.stroke-dashoffset]="offset()"
          [class]="strokeClass()"
        />
      </svg>
      <span class="absolute text-center">
        <span class="block text-2xl font-semibold text-slate-900">{{ formatted() }}</span>
        <span class="block text-xs text-slate-500">sur 5</span>
      </span>
    </div>
  `,
})
export class ScoreDialComponent {
  readonly score = input.required<number>();
  /** Libellé qualitatif, repris tel quel dans l'annonce vocale. */
  readonly qualifier = input<string>('');

  readonly circumference = CIRCUMFERENCE;

  readonly formatted = computed(() => this.score().toFixed(1).replace('.', ','));

  readonly offset = computed(() => {
    const ratio = Math.min(1, Math.max(0, this.score() / 5));
    return CIRCUMFERENCE * (1 - ratio);
  });

  readonly strokeClass = computed(() => {
    const score = this.score();
    if (score >= SCORE_GOOD) return 'stroke-emerald-500';
    if (score >= SCORE_WARNING) return 'stroke-amber-500';
    return 'stroke-red-500';
  });

  readonly ariaLabel = computed(() => {
    const qualifier = this.qualifier();
    return `Score ${this.formatted()} sur 5${qualifier ? ` — ${qualifier}` : ''}`;
  });
}
