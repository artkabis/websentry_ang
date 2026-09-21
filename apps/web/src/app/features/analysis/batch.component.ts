import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AnalysisReport, SseBatchEvent } from '@websentry/shared';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { ReportViewComponent } from './report-view.component';
import { DEFAULT_FILTER, type ReportFilter } from './report-view';

/** Phase du parcours — une seule à l'écran à la fois. */
type Phase = 'idle' | 'running' | 'done' | 'error';

/** Une page du lot, telle que l'écran la suit. */
interface BatchRow {
  url: string;
  ok: boolean;
  report: AnalysisReport | null;
}

/** Au-delà, le lot est refusé côté API : autant le dire avant de partir. */
const MAX_URLS = 200;

/**
 * Analyse d'un lot d'adresses.
 *
 * Le résultat arrive PAGE PAR PAGE, par un flux : un lot de deux cents pages
 * demande plusieurs minutes, et une réponse unique laisserait l'écran figé tout
 * ce temps avant de livrer plusieurs mégaoctets d'un coup. Chaque page s'affiche
 * dès qu'elle est terminée, et les échecs se lisent immédiatement — c'est
 * généralement pour eux qu'on regarde un lot en cours.
 *
 * Le rapport d'une page se déplie sur place, dans le même composant que
 * l'analyse unitaire : aucun rendu n'est réécrit pour l'occasion.
 */
@Component({
  selector: 'ws-batch',
  standalone: true,
  imports: [FormsModule, RouterLink, ReportViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900">Analyser un lot</h1>
        <p class="mt-1 text-sm text-slate-500">
          Une adresse par ligne, jusqu'à {{ maxUrls }}. Les pages s'affichent au fil de l'eau.
        </p>
      </header>

      <form class="mt-6" (ngSubmit)="start()">
        <label class="block">
          <span class="text-sm font-medium text-slate-700">Adresses à analyser</span>
          <textarea
            name="urls"
            rows="6"
            [ngModel]="raw()"
            (ngModelChange)="raw.set($event)"
            placeholder="https://exemple.fr/&#10;https://exemple.fr/contact"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
          ></textarea>
        </label>

        <div class="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            [disabled]="!canStart()"
            class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ phase() === 'running' ? 'Analyse en cours…' : 'Analyser le lot' }}
          </button>
          @if (phase() === 'running') {
            <button
              type="button"
              (click)="cancel()"
              class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              Interrompre
            </button>
          }
          <span class="text-sm text-slate-500">{{ countHint() }}</span>
        </div>
      </form>

      <p role="status" aria-live="polite" class="mt-4 text-sm text-slate-500">
        {{ statusMessage() }}
      </p>

      @if (error(); as message) {
        <div class="mt-3 rounded-lg bg-red-50 p-4" role="alert">
          <p class="text-sm text-red-700">{{ message }}</p>
          <button
            type="button"
            (click)="start()"
            class="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Réessayer
          </button>
        </div>
      }

      @if (phase() === 'running') {
        <div class="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
          <!-- La barre mesure des pages TERMINÉES : une barre estimée ment dès
               que le site analysé est lent. -->
          <div
            class="h-full rounded-full bg-brand-600 transition-[width] duration-300"
            role="progressbar"
            [attr.aria-valuenow]="rows().length"
            [attr.aria-valuemin]="0"
            [attr.aria-valuemax]="total()"
            aria-label="Pages analysées"
            [style.width.%]="percent()"
          ></div>
        </div>
      }

      @if (rows().length > 0) {
        <dl class="mt-4 grid grid-cols-3 gap-3">
          <div class="rounded-lg bg-white p-3 text-center ring-1 ring-slate-200">
            <dt class="text-xs text-slate-500">Analysées</dt>
            <dd class="mt-1 text-lg font-semibold text-slate-900">{{ rows().length }}</dd>
          </div>
          <div class="rounded-lg bg-white p-3 text-center ring-1 ring-slate-200">
            <dt class="text-xs text-slate-500">En échec</dt>
            <dd class="mt-1 text-lg font-semibold text-slate-900">{{ failed() }}</dd>
          </div>
          <div class="rounded-lg bg-white p-3 text-center ring-1 ring-slate-200">
            <dt class="text-xs text-slate-500">Score moyen</dt>
            <dd class="mt-1 text-lg font-semibold text-slate-900">{{ averageScore() }}</dd>
          </div>
        </dl>

        <ul class="mt-4 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          @for (row of rows(); track row.url) {
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                [attr.aria-expanded]="isOpen(row.url)"
                [disabled]="!row.report"
                (click)="toggle(row.url)"
              >
                <span [class]="badgeClass(row)">{{ rowScore(row) }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-slate-800">{{ row.url }}</span>
                  @if (!row.ok) {
                    <span class="block text-xs text-red-600">Analyse impossible</span>
                  }
                </span>
                @if (row.report) {
                  <span class="text-xs text-slate-400" aria-hidden="true">
                    {{ isOpen(row.url) ? 'replier' : 'voir le rapport' }}
                  </span>
                }
              </button>

              @if (isOpen(row.url) && row.report; as report) {
                <div class="border-t border-slate-100 bg-slate-50 px-4 py-4">
                  <ws-report-view
                    [report]="report"
                    [filter]="filter()"
                    (filterChange)="filter.set($event)"
                  />
                </div>
              }
            </li>
          }
        </ul>

        <p class="mt-4 text-xs text-slate-400">
          Les pages analysées rejoignent
          <a routerLink="/historique" class="text-brand-700 hover:underline">l'historique</a>
          au fil du lot.
        </p>
      }
    </main>
  `,
})
export class BatchComponent {
  private readonly api = inject(AnalysisApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly maxUrls = MAX_URLS;
  readonly raw = signal('');
  readonly phase = signal<Phase>('idle');
  readonly error = signal<string | null>(null);
  readonly rows = signal<BatchRow[]>([]);
  readonly total = signal(0);
  readonly filter = signal<ReportFilter>(DEFAULT_FILTER);
  private readonly opened = signal<string | null>(null);

  private controller: AbortController | null = null;

  constructor() {
    // Un lot en cours quand l'écran disparaît n'a plus de destinataire :
    // l'interrompre libère aussi les connexions sortantes côté serveur.
    this.destroyRef.onDestroy(() => this.controller?.abort());
  }

  /** Adresses saisies, élaguées et dédoublonnées — l'API refuse les doublons. */
  readonly urls = computed(() => [
    ...new Set(
      this.raw()
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean),
    ),
  ]);

  readonly canStart = computed(
    () => this.urls().length > 0 && this.urls().length <= MAX_URLS && this.phase() !== 'running',
  );

  readonly countHint = computed(() => {
    const count = this.urls().length;
    if (count === 0) return '';
    if (count > MAX_URLS) return `${count} adresses — le maximum est de ${MAX_URLS}.`;
    return `${count} adresse(s) distincte(s).`;
  });

  readonly percent = computed(() => {
    const total = this.total();
    return total === 0 ? 0 : Math.round((this.rows().length / total) * 100);
  });

  readonly failed = computed(() => this.rows().filter(row => !row.ok).length);

  /** Moyenne des pages MESURÉES : une page en échec n'a pas de note à moyenner. */
  readonly averageScore = computed(() => {
    const scores = this.rows()
      .map(row => row.report?.globalScore)
      .filter((score): score is number => typeof score === 'number');
    if (scores.length === 0) return '—';
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return `${Math.round(average * 10) / 10}/5`;
  });

  readonly statusMessage = computed(() => {
    switch (this.phase()) {
      case 'running':
        return this.total() === 0
          ? 'Ouverture du lot…'
          : `${this.rows().length} page(s) sur ${this.total()} analysée(s).`;
      case 'done':
        return `Lot terminé : ${this.rows().length} page(s), ${this.failed()} en échec.`;
      case 'error':
        return 'L’analyse du lot a échoué.';
      default:
        return 'Saisissez des adresses pour lancer un lot.';
    }
  });

  isOpen(url: string): boolean {
    return this.opened() === url;
  }

  /** Un seul rapport ouvert à la fois : deux rapports dépliés ne se comparent pas. */
  toggle(url: string): void {
    this.opened.update(current => (current === url ? null : url));
  }

  async start(): Promise<void> {
    const urls = this.urls();
    if (urls.length === 0 || urls.length > MAX_URLS) return;

    this.cancel();
    this.controller = new AbortController();

    this.phase.set('running');
    this.error.set(null);
    this.rows.set([]);
    this.total.set(0);
    this.opened.set(null);

    try {
      for await (const event of this.api.batchStream(urls, undefined, this.controller.signal)) {
        this.consume(event);
      }
      // Le flux s'est achevé sans événement terminal : la connexion a été
      // coupée en route. Le dire vaut mieux qu'une liste figée à mi-chemin.
      if (this.phase() === 'running') {
        this.fail('La connexion au serveur a été interrompue avant la fin du lot.');
      }
    } catch (err) {
      if (this.controller?.signal.aborted) {
        this.phase.set('idle');
        return;
      }
      this.fail(err instanceof Error ? err.message : 'L’analyse du lot a échoué.');
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.phase() === 'running') this.phase.set('idle');
  }

  private consume(event: SseBatchEvent): void {
    switch (event.type) {
      case 'start':
        this.total.set(event.total);
        break;
      case 'page':
        this.total.set(event.total);
        this.rows.update(rows => [...rows, { url: event.url, ok: event.ok, report: event.report }]);
        break;
      case 'complete':
        this.total.set(event.total);
        this.phase.set('done');
        break;
      case 'error':
        this.fail(event.message);
        break;
    }
  }

  private fail(message: string): void {
    this.error.set(message);
    this.phase.set('error');
  }

  rowScore(row: BatchRow): string {
    return row.report ? `${row.report.globalScore}` : '—';
  }

  badgeClass(row: BatchRow): string {
    const base = 'inline-flex size-9 items-center justify-center rounded-lg text-sm font-semibold ';
    if (!row.report) return `${base}bg-slate-100 text-slate-500`;
    if (row.report.globalScore >= 4) return `${base}bg-emerald-100 text-emerald-800`;
    if (row.report.globalScore >= 3) return `${base}bg-amber-100 text-amber-800`;
    return `${base}bg-red-100 text-red-800`;
  }
}
