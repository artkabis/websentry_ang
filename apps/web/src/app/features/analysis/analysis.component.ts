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
  imports: [FormsModule, RouterLink, CheckCardComponent, ScoreDialComponent, StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900">Analyser une page</h1>
        <p class="mt-1 text-sm text-slate-500">
          Les critères sont évalués un par un ; le rapport s'affiche au fil de l'eau.
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

      <!-- ── Niveau 1 : verdict et priorités ─────────────────────────────── -->
      @if (report(); as result) {
        <section class="mt-8" aria-labelledby="titre-verdict">
          <div
            class="flex flex-wrap items-center gap-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
          >
            <ws-score-dial [score]="result.globalScore" [qualifier]="verdict().headline" />
            <div class="min-w-0 flex-1">
              <h2 id="titre-verdict" class="text-lg font-semibold text-slate-900">
                {{ verdict().headline }}
              </h2>
              <p class="mt-1 text-sm text-slate-600">{{ verdict().detail }}</p>
              <p class="mt-2 truncate text-xs text-slate-400">{{ result.url }}</p>
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
                (click)="setFilter('attention')"
                [attr.aria-pressed]="filter() === 'attention'"
                [class]="filterClass('attention')"
              >
                À traiter ({{ toFix() }})
              </button>
              <button
                type="button"
                (click)="setFilter('all')"
                [attr.aria-pressed]="filter() === 'all'"
                [class]="filterClass('all')"
              >
                Tout ({{ totalChecks() }})
              </button>
            </div>
          </div>

          @if (hiddenTotal() > 0) {
            <p class="mt-2 text-xs text-slate-500">
              {{ hiddenTotal() }} critère(s) conforme(s) ou non applicable(s) masqué(s) par le
              filtre.
            </p>
          }

          @if (visibleGroups().length === 0) {
            <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
              <p class="text-sm text-slate-600">Aucun critère ne demande d'action.</p>
              <button
                type="button"
                (click)="setFilter('all')"
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
                    <ws-check-card [check]="check" [pageUrl]="result.url" />
                  }
                </div>
              </section>
            }
          }

          <p class="mt-6 text-xs text-slate-400">
            Analyse du {{ result.analyzedAt }} · {{ result.durationMs }} ms ·
            <a routerLink="/historique" class="text-brand-700 hover:underline">
              retrouver ce scan dans l'historique
            </a>
          </p>
        </section>
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

  readonly verdict = computed(() => {
    const result = this.report();
    if (!result) return verdictOf(0, 0);
    const counts = countStatuses(Object.values(result.checks));
    return verdictOf(result.globalScore, counts.fail + counts.warning);
  });

  readonly actions = computed(() => {
    const result = this.report();
    return result ? priorityActions(result) : [];
  });

  readonly totalChecks = computed(() => Object.keys(this.report()?.checks ?? {}).length);

  readonly toFix = computed(() => {
    const result = this.report();
    if (!result) return 0;
    const counts = countStatuses(Object.values(result.checks));
    return counts.fail + counts.warning;
  });

  /**
   * Nombre de critères que le filtre masque, TOUS groupes confondus.
   *
   * Le décompte est global et non par groupe : un groupe entièrement conforme
   * disparaît de l'affichage, et un décompte posé à l'intérieur disparaîtrait
   * avec lui — l'utilisateur ne saurait alors rien de ces critères-là.
   */
  readonly hiddenTotal = computed(() => {
    const result = this.report();
    if (!result) return 0;
    return hiddenCount(Object.values(result.checks), this.filter());
  });

  /** Groupes avec leurs critères filtrés — les groupes devenus vides disparaissent. */
  readonly visibleGroups = computed(() => {
    const result = this.report();
    if (!result) return [];

    return groupChecks(result)
      .map(group => ({ ...group, visible: applyFilter(group.checks, this.filter()) }))
      .filter(group => group.visible.length > 0);
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
