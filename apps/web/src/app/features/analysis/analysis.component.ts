import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AnalysisReport, CheckResult, SseAnalyzeEvent } from '@websentry/shared';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { ReportViewComponent } from './report-view.component';
import { StatusBadgeComponent } from './status-badge.component';
import { DEFAULT_FILTER, type ReportFilter } from './report-view';

/** Phase du parcours — une seule à l'écran à la fois. */
type Phase = 'idle' | 'running' | 'done' | 'error';

/**
 * Analyse d'une page — lancement, progression, rapport.
 *
 * Trois niveaux de lecture, et c'est tout le remaniement :
 *
 *   1. **le verdict** — un score, une phrase, et les trois corrections les plus
 *      rentables. C'est ce qu'on lit quand on n'a que trente secondes ;
 *   2. **les critères** — groupés par famille, filtrés par défaut sur ce qui
 *      demande une action ;
 *   3. **le détail** — recommandations puis points de contrôle, à l'ouverture
 *      d'un critère.
 *
 * Le filtre par défaut est le choix central : un rapport qui s'ouvre sur
 * vingt-neuf lignes dont vingt-cinq vertes se survole, et on rate les quatre
 * rouges avec. Ce qui est masqué reste compté à l'écran, jamais implicite.
 */
/** Paramètres d'adresse — en français, comme les routes de l'application. */
const URL_PARAM = 'url';
const FILTER_PARAM = 'filtre';
/** Seule valeur écrite : le filtre par défaut n'encombre pas l'adresse. */
const FILTER_ALL_VALUE = 'tous';

@Component({
  selector: 'ws-analysis',
  standalone: true,
  imports: [FormsModule, RouterLink, ReportViewComponent, StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900">Analyser une page</h1>
        <p class="mt-1 text-sm text-slate-500">
          Les critères sont évalués un par un ; le rapport s'affiche au fil de l'eau.
          <a routerLink="/analyse/lot" class="text-brand-700 hover:underline">
            Analyser plusieurs pages
          </a>
        </p>
      </header>

      <!-- ── Lancement ───────────────────────────────────────────────────── -->
      <form class="mt-6 flex flex-wrap gap-2" (ngSubmit)="start()">
        <label class="min-w-0 flex-1">
          <span class="sr-only">Adresse de la page à analyser</span>
          <input
            type="url"
            name="url"
            [ngModel]="url()"
            (ngModelChange)="url.set($event)"
            placeholder="https://exemple.fr/"
            required
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          [disabled]="!canStart()"
          class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ phase() === 'running' ? 'Analyse en cours…' : 'Analyser' }}
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
      </form>

      <p role="status" aria-live="polite" class="mt-4 text-sm text-slate-500">
        {{ statusMessage() }}
      </p>

      <!-- ── Progression ─────────────────────────────────────────────────── -->
      @if (phase() === 'running') {
        <div class="mt-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div
            class="h-2 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            [attr.aria-valuenow]="completed()"
            [attr.aria-valuemin]="0"
            [attr.aria-valuemax]="total()"
            [attr.aria-label]="'Critères analysés'"
          >
            <!-- La barre mesure des critères TERMINÉS, pas une minuterie : une
                 barre estimée ment dès que le site analysé est lent. -->
            <div
              class="h-full rounded-full bg-brand-600 transition-[width] duration-300"
              [style.width.%]="percent()"
            ></div>
          </div>

          @if (liveChecks().length > 0) {
            <ul class="mt-3 space-y-1">
              @for (check of liveChecks(); track check.checkId) {
                <li class="flex items-center gap-2 text-sm">
                  <ws-status-badge [status]="check.status" />
                  <span class="text-slate-700">{{ check.checkTitle }}</span>
                </li>
              }
            </ul>
          }
        </div>
      }

      @if (error(); as message) {
        <div class="mt-4 rounded-lg bg-red-50 p-4" role="alert">
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

      <!-- ── Rapport : verdict, critères, détail ─────────────────────────── -->
      @if (report(); as result) {
        <div class="mt-8">
          <ws-report-view [report]="result" [filter]="filter()" (filterChange)="setFilter($event)">
            <p class="mt-6 text-xs text-slate-400">
              Analyse du {{ result.analyzedAt }} · {{ result.durationMs }} ms ·
              <a routerLink="/historique" class="text-brand-700 hover:underline">
                retrouver ce scan dans l'historique
              </a>
            </p>
          </ws-report-view>
        </div>
      }
    </main>
  `,
})
export class AnalysisComponent {
  private readonly api = inject(AnalysisApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly url = signal('');
  readonly phase = signal<Phase>('idle');
  readonly error = signal<string | null>(null);
  readonly report = signal<AnalysisReport | null>(null);
  readonly filter = signal<ReportFilter>(DEFAULT_FILTER);

  /** Critères déjà arrivés pendant l'analyse — la progression est concrète. */
  readonly liveChecks = signal<CheckResult[]>([]);
  readonly completed = signal(0);
  readonly total = signal(0);

  private controller: AbortController | null = null;

  constructor() {
    // Une analyse en cours quand l'écran disparaît n'a plus de destinataire :
    // l'interrompre libère aussi la connexion sortante côté serveur.
    this.destroyRef.onDestroy(() => this.controller?.abort());

    this.restoreFromUrl();
  }

  /**
   * L'écran reprend son état depuis l'adresse.
   *
   * Un rapport se partage et se recharge : sans cela, envoyer « regarde cette
   * analyse » à un collègue revient à lui envoyer un formulaire vide, et un
   * rafraîchissement perd le travail en cours.
   */
  private restoreFromUrl(): void {
    const params = this.route.snapshot.queryParamMap;

    const filter = params.get(FILTER_PARAM);
    if (filter === FILTER_ALL_VALUE) this.filter.set('all');

    const url = params.get(URL_PARAM)?.trim();
    if (!url) return;

    this.url.set(url);
    // Le filtre vient du lien : une nouvelle analyse le remettrait à sa valeur
    // par défaut et trahirait ce que l'expéditeur voulait montrer.
    void this.start({ resetFilter: false });
  }

  /**
   * Écrit l'état dans l'adresse, SANS empiler d'entrée d'historique.
   *
   * L'écran est un plan de travail, pas une suite de pages : un retour arrière
   * doit ramener à l'écran précédent, pas défaire un changement de filtre.
   */
  private writeToUrl(): void {
    const url = this.url().trim();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        [URL_PARAM]: url || null,
        // Le filtre par défaut n'encombre pas l'adresse.
        [FILTER_PARAM]: this.filter() === 'all' ? FILTER_ALL_VALUE : null,
      },
      replaceUrl: true,
    });
  }

  setFilter(value: ReportFilter): void {
    this.filter.set(value);
    this.writeToUrl();
  }

  readonly canStart = computed(() => this.url().trim().length > 0 && this.phase() !== 'running');

  readonly percent = computed(() => {
    const total = this.total();
    return total === 0 ? 0 : Math.round((this.completed() / total) * 100);
  });

  readonly statusMessage = computed(() => {
    switch (this.phase()) {
      case 'running':
        return this.total() === 0
          ? 'Connexion à la page…'
          : `${this.completed()} critère(s) sur ${this.total()} analysé(s).`;
      case 'done':
        return 'Analyse terminée.';
      case 'error':
        return 'L’analyse a échoué.';
      default:
        return 'Saisissez une adresse pour lancer une analyse.';
    }
  });

  async start(options: { resetFilter?: boolean } = {}): Promise<void> {
    const url = this.url().trim();
    if (!url) return;

    this.cancel();
    this.controller = new AbortController();

    this.phase.set('running');
    this.error.set(null);
    this.report.set(null);
    this.liveChecks.set([]);
    this.completed.set(0);
    this.total.set(0);
    if (options.resetFilter !== false) this.filter.set(DEFAULT_FILTER);
    this.writeToUrl();

    try {
      for await (const event of this.api.stream({ url }, this.controller.signal)) {
        this.consume(event);
      }
      // Le flux s'est achevé sans événement terminal : la connexion a été
      // coupée en route. Le dire vaut mieux que laisser une barre figée.
      if (this.phase() === 'running') {
        this.fail('La connexion au serveur a été interrompue avant la fin de l’analyse.');
      }
    } catch (err) {
      if (this.controller?.signal.aborted) {
        this.phase.set('idle');
        return;
      }
      this.fail(err instanceof Error ? err.message : 'L’analyse a échoué.');
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.phase() === 'running') this.phase.set('idle');
  }

  private consume(event: SseAnalyzeEvent): void {
    switch (event.type) {
      case 'start':
        this.total.set(event.total);
        break;
      case 'check':
        this.completed.set(event.completed);
        this.total.set(event.total);
        this.liveChecks.update(checks => [...checks, event.result]);
        break;
      case 'complete':
        this.report.set(event.report);
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
}
