import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { AnalysisReport } from '@websentry/shared';
import { CheckCardComponent } from './check-card.component';
import { ScoreDialComponent } from './score-dial.component';
import { StatusBadgeComponent } from './status-badge.component';
import {
  applyFilter,
  countStatuses,
  DEFAULT_FILTER,
  groupChecks,
  hiddenCount,
  priorityActions,
  verdictOf,
  type ReportFilter,
} from './report-view';

/**
 * Rendu d'un rapport d'analyse — trois niveaux de lecture.
 *
 *   1. **le verdict** — un score, une phrase, et les trois corrections les plus
 *      rentables. C'est ce qu'on lit quand on n'a que trente secondes ;
 *   2. **les critères** — groupés par famille, filtrés par défaut sur ce qui
 *      demande une action ;
 *   3. **le détail** — recommandations puis points de contrôle, à l'ouverture
 *      d'un critère.
 *
 * Le composant est PUREMENT présentationnel : il ne sait ni d'où vient le
 * rapport — un flux en direct, l'historique — ni où le filtre est conservé.
 * C'est ce qui permet à l'écran d'analyse et à celui de l'historique de montrer
 * exactement la même chose, au lieu d'en maintenir deux versions qui divergent.
 *
 * Le filtre est PILOTÉ par l'écran hôte plutôt que gardé ici : c'est lui qui
 * sait le porter dans l'adresse, donc le rendre partageable.
 */
@Component({
  selector: 'ws-report-view',
  standalone: true,
  imports: [CheckCardComponent, ScoreDialComponent, StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="titre-verdict">
      <div
        class="flex flex-wrap items-center gap-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
      >
        <ws-score-dial [score]="report().globalScore" [qualifier]="verdict().headline" />
        <div class="min-w-0 flex-1">
          <h2 id="titre-verdict" class="text-lg font-semibold text-slate-900">
            {{ verdict().headline }}
          </h2>
          <p class="mt-1 text-sm text-slate-600">{{ verdict().detail }}</p>
          <p class="mt-2 truncate text-xs text-slate-400">{{ report().url }}</p>
        </div>
      </div>

      @if (actions().length > 0) {
        <div class="mt-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h3 class="text-sm font-semibold text-slate-900">À corriger en priorité</h3>
          <p class="mt-0.5 text-xs text-slate-500">
            Classé par gravité et par poids du critère dans le score.
          </p>
          <ol class="mt-3 space-y-3">
            @for (action of actions(); track action.checkId) {
              <li class="flex items-start gap-3">
                <ws-status-badge [status]="action.status" />
                <span class="min-w-0 flex-1">
                  <span class="block text-sm text-slate-800">{{ action.action }}</span>
                  <span class="block text-xs text-slate-500">
                    {{ action.checkTitle }}
                    @if (action.weight !== 1) {
                      · poids {{ action.weight }}
                    }
                  </span>
                </span>
              </li>
            }
          </ol>
        </div>
      }

      <!-- ── Niveau 2 : critères par famille ───────────────────────── -->
      <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-slate-900">Détail des critères</h3>
        <div
          class="flex items-center gap-1 rounded-lg bg-slate-100 p-1"
          role="group"
          aria-label="Filtrer les critères"
        >
          <button
            type="button"
            (click)="filterChange.emit('attention')"
            [attr.aria-pressed]="filter() === 'attention'"
            [class]="filterClass('attention')"
          >
            À traiter ({{ toFix() }})
          </button>
          <button
            type="button"
            (click)="filterChange.emit('all')"
            [attr.aria-pressed]="filter() === 'all'"
            [class]="filterClass('all')"
          >
            Tout ({{ totalChecks() }})
          </button>
        </div>
      </div>

      @if (hiddenTotal() > 0) {
        <p class="mt-2 text-xs text-slate-500">
          {{ hiddenTotal() }} critère(s) conforme(s) ou non applicable(s) masqué(s) par le filtre.
        </p>
      }

      @if (visibleGroups().length === 0) {
        <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
          <p class="text-sm text-slate-600">Aucun critère ne demande d'action.</p>
          <button
            type="button"
            (click)="filterChange.emit('all')"
            class="mt-3 text-sm font-medium text-brand-700 hover:underline"
          >
            Afficher les {{ totalChecks() }} critères évalués
          </button>
        </div>
      } @else {
        @for (group of visibleGroups(); track group.group) {
          <section class="mt-4" [attr.aria-label]="group.group">
            <h4
              class="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              {{ group.group }}
              <span class="font-normal normal-case tracking-normal">
                {{ groupSummary(group.counts) }}
              </span>
            </h4>
            <div class="mt-2 rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
              @for (check of group.visible; track check.checkId) {
                <ws-check-card [check]="check" [pageUrl]="report().url" />
              }
            </div>
          </section>
        }
      }

      <!-- Pied laissé à l'écran hôte : il seul sait d'où vient ce rapport. -->
      <ng-content />
    </section>
  `,
})
export class ReportViewComponent {
  readonly report = input.required<AnalysisReport>();
  readonly filter = input<ReportFilter>(DEFAULT_FILTER);
  readonly filterChange = output<ReportFilter>();

  readonly verdict = computed(() => {
    const result = this.report();
    const counts = countStatuses(Object.values(result.checks));
    return verdictOf(result.globalScore, counts.fail + counts.warning);
  });

  readonly actions = computed(() => priorityActions(this.report()));

  readonly totalChecks = computed(() => Object.keys(this.report().checks).length);

  readonly toFix = computed(() => {
    const counts = countStatuses(Object.values(this.report().checks));
    return counts.fail + counts.warning;
  });

  /**
   * Nombre de critères que le filtre masque, TOUS groupes confondus.
   *
   * Le décompte est global et non par groupe : un groupe entièrement conforme
   * disparaît de l'affichage, et un décompte posé à l'intérieur disparaîtrait
   * avec lui — l'utilisateur ne saurait alors rien de ces critères-là.
   */
  readonly hiddenTotal = computed(() =>
    hiddenCount(Object.values(this.report().checks), this.filter()),
  );

  /** Groupes avec leurs critères filtrés — les groupes devenus vides disparaissent. */
  readonly visibleGroups = computed(() =>
    groupChecks(this.report())
      .map(group => ({ ...group, visible: applyFilter(group.checks, this.filter()) }))
      .filter(group => group.visible.length > 0),
  );

  filterClass(value: ReportFilter): string {
    const base = 'rounded-md px-3 py-1 text-xs font-medium transition-colors ';
    return this.filter() === value
      ? `${base}bg-white text-slate-900 shadow-sm`
      : `${base}text-slate-600 hover:text-slate-900`;
  }

  /** Résumé chiffré d'un groupe — la couleur ne porte jamais seule l'information. */
  groupSummary(counts: { fail: number; warning: number; pass: number; na: number }): string {
    const parts: string[] = [];
    if (counts.fail > 0) parts.push(`${counts.fail} en échec`);
    if (counts.warning > 0) parts.push(`${counts.warning} à surveiller`);
    if (counts.pass > 0) parts.push(`${counts.pass} conforme(s)`);
    if (counts.na > 0) parts.push(`${counts.na} non applicable(s)`);
    return parts.join(' · ');
  }
}
