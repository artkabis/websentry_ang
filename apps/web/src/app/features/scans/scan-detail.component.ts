import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AnalysisReport, CheckStatus, ScanPage } from '@websentry/shared';
import { ScanReportPurgedError, ScansApi } from '../../core/scans/scans.api';
import { ReportViewComponent } from '../analysis/report-view.component';
import { DEFAULT_FILTER, type ReportFilter } from '../analysis/report-view';
import { checkStatusLabel, formatScore, scoreBadgeClass } from './scan-format';

/** Paramètre d'adresse du filtre — mêmes mots que sur l'écran d'analyse. */
const FILTER_PARAM = 'filtre';
const FILTER_ALL_VALUE = 'tous';

/**
 * Rapport d'une page archivée.
 *
 * L'écran ne réinvente RIEN du rendu : il monte le même composant que l'analyse
 * en direct. Un rapport relu six mois plus tard doit se lire comme le jour où
 * il a été produit — deux rendus séparés divergeraient au premier changement.
 *
 * Le cas purgé a son propre état, et non un message d'erreur : la rétention a
 * effacé le rapport, ce n'est pas une panne. Le résumé par critère arrive avec
 * le refus, si bien qu'un lien ouvert directement reste informatif.
 */
@Component({
  selector: 'ws-scan-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, ReportViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <nav class="text-sm">
        <a routerLink="/historique" class="text-brand-700 hover:underline">
          ← Retour à l'historique
        </a>
      </nav>

      <p role="status" aria-live="polite" class="mt-4 text-sm text-slate-500">
        {{ statusMessage() }}
      </p>

      @if (error(); as message) {
        <div class="mt-3 rounded-lg bg-red-50 p-4" role="alert">
          <p class="text-sm text-red-700">{{ message }}</p>
          <button
            type="button"
            (click)="reload()"
            class="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Réessayer
          </button>
        </div>
      } @else if (loading()) {
        <div class="mt-3 space-y-3" aria-hidden="true">
          <div class="h-28 animate-pulse rounded-xl bg-slate-100"></div>
          <div class="h-40 animate-pulse rounded-xl bg-slate-100"></div>
        </div>
      } @else if (purged(); as gone) {
        <!-- ── Rapport purgé : un état, pas une erreur ────────────────────── -->
        <section class="mt-3 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 class="text-lg font-semibold text-slate-900">Rapport purgé</h1>
          <p class="mt-1 text-sm text-slate-600">
            @if (gone.purgedAt) {
              La politique de rétention a effacé le rapport complet le
              {{ gone.purgedAt | date: 'dd/MM/yyyy' }}.
            } @else {
              La politique de rétention a effacé le rapport complet.
            }
            Le résumé par critère reste consultable.
          </p>

          @if (gone.scan; as scan) {
            <dl class="mt-4 grid gap-3 sm:grid-cols-3">
              <div>
                <dt class="text-xs text-slate-500">Page</dt>
                <dd class="truncate text-sm text-slate-800">{{ scan.url }}</dd>
              </div>
              <div>
                <dt class="text-xs text-slate-500">Analysée le</dt>
                <dd class="text-sm text-slate-800">
                  {{ scan.analyzedAt | date: 'dd/MM/yyyy HH:mm' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-slate-500">Score</dt>
                <dd>
                  <span [class]="badge(scan.globalScore)">{{ score(scan.globalScore) }}</span>
                </dd>
              </div>
            </dl>

            <h2 class="mt-6 text-sm font-semibold text-slate-900">Résumé par critère</h2>
            <ul class="mt-2 flex flex-wrap gap-2">
              @for (entry of summary(scan); track entry.checkId) {
                <li class="rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-700">
                  {{ entry.checkId }} :
                  <span class="font-medium">{{ entry.label }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="mt-4 text-sm text-slate-500">
              Aucun résumé n'accompagne ce scan : il a été purgé par une version antérieure de
              l'application.
            </p>
          }
        </section>
      } @else if (report(); as result) {
        <header class="mt-3">
          <h1 class="truncate text-2xl font-semibold text-slate-900">{{ result.title }}</h1>
          <p class="mt-1 truncate text-sm text-slate-500">{{ result.url }}</p>
        </header>

        <div class="mt-6">
          <ws-report-view [report]="result" [filter]="filter()" (filterChange)="setFilter($event)">
            <p class="mt-6 text-xs text-slate-400">
              Analyse du {{ result.analyzedAt | date: 'dd/MM/yyyy HH:mm' }} ·
              {{ result.durationMs }} ms
              @if (scan(); as page) {
                @if (page.launchedBy) {
                  · lancée par {{ page.launchedBy }}
                }
                ·
                <a
                  routerLink="/historique/site"
                  [queryParams]="{ domain: page.domain, gamme: page.gamme }"
                  class="text-brand-700 hover:underline"
                >
                  tous les audits de {{ page.domain }}
                </a>
              }
            </p>
          </ws-report-view>
        </div>
      }
    </main>
  `,
})
export class ScanDetailComponent {
  private readonly api = inject(ScansApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Identifiant lié par la route (`withComponentInputBinding`). */
  readonly pageId = input.required<string>();

  readonly report = signal<AnalysisReport | null>(null);
  readonly scan = signal<ScanPage | null>(null);
  readonly purged = signal<{ purgedAt: string | null; scan: ScanPage | null } | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly filter = signal<ReportFilter>(DEFAULT_FILTER);

  constructor() {
    if (this.route.snapshot.queryParamMap.get(FILTER_PARAM) === FILTER_ALL_VALUE) {
      this.filter.set('all');
    }
    // Un `effect` et non un appel dans le constructeur : l'entrée de route n'est
    // pas encore résolue à la construction, et Angular RÉUTILISE le composant
    // d'une page à l'autre — sans cela, passer d'un rapport au suivant
    // afficherait le précédent.
    effect(() => {
      const id = this.pageId();
      void this.load(id);
    });
  }

  readonly statusMessage = computed(() => {
    if (this.loading()) return 'Chargement du rapport…';
    if (this.error()) return 'Le rapport n’a pas pu être chargé.';
    if (this.purged()) return 'Le rapport complet a été purgé ; son résumé reste affiché.';
    return 'Rapport chargé.';
  });

  async reload(): Promise<void> {
    await this.load(this.pageId());
  }

  private async load(pageId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.purged.set(null);

    try {
      const { scan, report } = await this.api.pageReport(pageId);
      this.scan.set(scan);
      this.report.set(report);
    } catch (err) {
      if (err instanceof ScanReportPurgedError) {
        this.purged.set({ purgedAt: err.purgedAt, scan: err.scan });
      } else {
        this.error.set(err instanceof Error ? err.message : 'Le rapport n’a pas pu être chargé.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Écrit le filtre dans l'adresse, sans empiler d'entrée d'historique.
   *
   * Même règle que l'écran d'analyse : un rapport se partage tel qu'on le
   * regarde, et un retour arrière ramène à l'écran précédent.
   */
  setFilter(value: ReportFilter): void {
    this.filter.set(value);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [FILTER_PARAM]: value === 'all' ? FILTER_ALL_VALUE : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Résumé par critère, trié pour que ce qui cloche se lise en premier. */
  summary(scan: ScanPage): { checkId: string; label: string }[] {
    const rank: Record<CheckStatus, number> = { fail: 0, warning: 1, info: 2, pass: 3, na: 4 };
    return Object.entries(scan.checkSummary)
      .map(([checkId, status]) => ({ checkId, status, label: checkStatusLabel(status) }))
      .sort((a, b) => rank[a.status] - rank[b.status] || a.checkId.localeCompare(b.checkId));
  }

  score(value: number | null): string {
    return formatScore(value);
  }

  badge(value: number | null): string {
    return scoreBadgeClass(value);
  }
}
