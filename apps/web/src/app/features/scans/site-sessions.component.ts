import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { SessionComparison, SiteSession } from '@websentry/shared';
import { ScansApi } from '../../core/scans/scans.api';
import {
  changeBadgeClass,
  changeLabel,
  formatDelta,
  formatScore,
  scoreBadgeClass,
  scoreLabelOf,
  trendBadgeClass,
  type CheckTrend,
  type PageChange,
} from './scan-format';

/** Nombre de sessions comparables à la fois — une comparaison oppose deux audits. */
const COMPARE_ARITY = 2;

/**
 * Historique d'un site — ses audits successifs, et leur comparaison.
 *
 * La comparaison est la raison d'être de cet écran. Une liste d'audits sans
 * moyen de les confronter ne répond pas à la question qu'on se pose en
 * l'ouvrant : « qu'est-ce qui a changé depuis la dernière fois ? ».
 *
 * Les coordonnées du site arrivent par la query string (`domain`, `gamme`) :
 * ce sont elles, et non un identifiant technique, qui identifient un site côté
 * API — et elles rendent l'URL lisible et partageable.
 */
@Component({
  selector: 'ws-site-sessions',
  standalone: true,
  imports: [RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-5xl px-4 py-10">
      <nav class="text-sm">
        <a routerLink="/historique" class="text-brand-700 hover:underline">
          ← Retour à l'historique
        </a>
      </nav>

      <header class="mt-4">
        <h1 class="text-2xl font-semibold text-slate-900">{{ domain() }}</h1>
        <p class="mt-1 text-sm text-slate-500">
          {{ gamme() ? 'Gamme ' + gamme() : 'Sans gamme' }}
        </p>
      </header>

      <p role="status" aria-live="polite" class="mt-6 text-sm text-slate-500">
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
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (row of skeleton; track row) {
            <div class="h-16 animate-pulse rounded-lg bg-slate-100"></div>
          }
        </div>
      } @else if (sessions().length === 0) {
        <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
          <p class="text-sm text-slate-600">Aucun audit enregistré pour ce site.</p>
        </div>
      } @else {
        <!-- ── Barre de comparaison ──────────────────────────────────────── -->
        <div
          class="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200"
        >
          <p class="text-sm text-slate-600">{{ selectionHint() }}</p>
          <button
            type="button"
            (click)="compare()"
            [disabled]="!canCompare() || comparing()"
            class="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ comparing() ? 'Comparaison…' : 'Comparer' }}
          </button>
          @if (selected().length > 0) {
            <button
              type="button"
              (click)="clearSelection()"
              class="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200"
            >
              Effacer la sélection
            </button>
          }
        </div>

        <ul
          class="mt-3 divide-y divide-slate-100 rounded-xl bg-white shadow-sm ring-1 ring-slate-200"
        >
          @for (session of sessions(); track session.sessionId) {
            <li class="flex items-center gap-4 px-4 py-3">
              <input
                type="checkbox"
                [id]="'session-' + session.sessionId"
                [checked]="isSelected(session.sessionId)"
                [disabled]="isSelectionFull() && !isSelected(session.sessionId)"
                (change)="toggleSelection(session.sessionId)"
                class="size-4 rounded border-slate-300"
              />
              <label [for]="'session-' + session.sessionId" class="min-w-0 flex-1 cursor-pointer">
                <span class="text-sm font-medium text-slate-900">
                  {{ session.analyzedAt | date: 'dd/MM/yyyy HH:mm' }}
                </span>
                <span class="block text-xs text-slate-500">
                  {{ session.pageCount }} page(s)
                  @if (session.launchedBy) {
                    · lancé par {{ session.launchedBy }}
                  }
                </span>
              </label>
              <span [class]="scoreClass(session.avgScore)">
                {{ score(session.avgScore) }}
              </span>
              <span class="sr-only">sur 5, {{ scoreLabel(session.avgScore) }}</span>
            </li>
          }
        </ul>
      }

      <!-- ── Résultat de la comparaison ──────────────────────────────────── -->
      @if (comparisonError(); as message) {
        <p role="alert" class="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ message }}
        </p>
      }

      @if (comparison(); as diff) {
        <section class="mt-8" aria-labelledby="titre-comparaison">
          <h2 id="titre-comparaison" class="text-lg font-semibold text-slate-900">
            Évolution entre deux audits
          </h2>
          <p class="mt-1 text-sm text-slate-500">
            Du {{ diff.base.analyzedAt | date: 'dd/MM/yyyy HH:mm' }} au
            {{ diff.target.analyzedAt | date: 'dd/MM/yyyy HH:mm' }} · score moyen
            {{ delta(diff.scoreDelta) }}
          </p>

          <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            @for (tile of summaryTiles(diff); track tile.label) {
              <div class="rounded-lg bg-white p-3 text-center ring-1 ring-slate-200">
                <dt class="text-xs text-slate-500">{{ tile.label }}</dt>
                <dd class="mt-1 text-lg font-semibold text-slate-900">{{ tile.value }}</dd>
              </div>
            }
          </dl>

          @if (diff.pages.length === 0) {
            <p class="mt-4 text-sm text-slate-500">Aucune page comparable entre ces deux audits.</p>
          } @else {
            <ul class="mt-4 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              @for (page of diff.pages; track page.url) {
                <li class="px-4 py-3">
                  <div class="flex items-start justify-between gap-4">
                    <p class="min-w-0 truncate text-sm text-slate-800">{{ page.url }}</p>
                    <span [class]="changeClass(page.change)">{{ changeLabel(page.change) }}</span>
                  </div>
                  @if (page.checks.length > 0) {
                    <ul class="mt-2 flex flex-wrap gap-1">
                      @for (check of page.checks; track check.checkId) {
                        <li [class]="trendClass(check.trend)">
                          {{ check.checkId }} : {{ check.baseStatus }} → {{ check.targetStatus }}
                        </li>
                      }
                    </ul>
                  }
                  @if (page.scoreDelta !== null) {
                    <p class="mt-1 text-xs text-slate-500">
                      Score {{ score(page.baseScore) }} → {{ score(page.targetScore) }} ({{
                        delta(page.scoreDelta)
                      }})
                    </p>
                  }
                </li>
              }
            </ul>
          }
        </section>
      }
    </main>
  `,
})
export class SiteSessionsComponent {
  private readonly api = inject(ScansApi);

  /** Liés depuis la query string par `withComponentInputBinding()`. */
  readonly domain = input.required<string>();
  readonly gamme = input<string | undefined>();

  readonly skeleton = [0, 1, 2];

  readonly sessions = signal<SiteSession[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly selected = signal<string[]>([]);
  readonly comparison = signal<SessionComparison | null>(null);
  readonly comparisonError = signal<string | null>(null);
  readonly comparing = signal(false);

  readonly canCompare = computed(() => this.selected().length === COMPARE_ARITY);
  readonly isSelectionFull = computed(() => this.selected().length >= COMPARE_ARITY);

  readonly statusMessage = computed(() => {
    if (this.loading()) return 'Chargement des audits…';
    if (this.error()) return 'Le chargement a échoué.';
    const count = this.sessions().length;
    return count === 0 ? 'Aucun audit.' : `${count} audit(s).`;
  });

  readonly selectionHint = computed(() => {
    const count = this.selected().length;
    if (count === 0) return 'Sélectionnez deux audits à comparer.';
    if (count === 1) return 'Sélectionnez un second audit.';
    return 'Deux audits sélectionnés.';
  });

  constructor() {
    // Un `effect` et non un appel dans le constructeur : les entrées de route
    // ne sont pas encore résolues à la construction, et surtout Angular RÉUTILISE
    // le composant quand on passe d'un site à l'autre — un chargement posé dans
    // le constructeur ne se rejouerait jamais, et l'écran afficherait les audits
    // du site précédent.
    effect(() => {
      const domain = this.domain();
      const gamme = this.gamme() ?? null;
      this.clearSelection();
      void this.load(domain, gamme);
    });
  }

  async load(domain: string, gamme: string | null): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.sessions.set(await this.api.siteSessions(domain, gamme));
    } catch {
      this.error.set('Impossible de charger les audits de ce site.');
      this.sessions.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  reload(): void {
    void this.load(this.domain(), this.gamme() ?? null);
  }

  isSelected(sessionId: string): boolean {
    return this.selected().includes(sessionId);
  }

  /**
   * Ajoute ou retire un audit de la sélection.
   *
   * La sélection est PLAFONNÉE à deux : au-delà, les cases restantes sont
   * désactivées plutôt que de laisser cocher un troisième audit qui serait
   * silencieusement ignoré au moment de comparer.
   */
  toggleSelection(sessionId: string): void {
    const current = this.selected();
    if (current.includes(sessionId)) {
      this.selected.set(current.filter(id => id !== sessionId));
      return;
    }
    if (current.length >= COMPARE_ARITY) return;
    this.selected.set([...current, sessionId]);
  }

  clearSelection(): void {
    this.selected.set([]);
    this.comparison.set(null);
    this.comparisonError.set(null);
  }

  async compare(): Promise<void> {
    const [first, second] = this.selected();
    if (!first || !second) return;

    this.comparing.set(true);
    this.comparisonError.set(null);
    try {
      // L'ordre n'a pas d'importance : l'API prend toujours le plus ancien
      // comme référence, si bien qu'un delta négatif signifie « ça a baissé ».
      this.comparison.set(await this.api.compare(first, second));
    } catch {
      this.comparison.set(null);
      this.comparisonError.set('La comparaison a échoué.');
    } finally {
      this.comparing.set(false);
    }
  }

  summaryTiles(diff: SessionComparison): ReadonlyArray<{ label: string; value: number }> {
    return [
      { label: 'Dégradées', value: diff.summary.degraded },
      { label: 'Améliorées', value: diff.summary.improved },
      { label: 'Inchangées', value: diff.summary.unchanged },
      { label: 'Ajoutées', value: diff.summary.added },
      { label: 'Disparues', value: diff.summary.removed },
    ];
  }

  score(value: number | null): string {
    return formatScore(value);
  }

  scoreLabel(value: number | null): string {
    return scoreLabelOf(value);
  }

  delta(value: number | null): string {
    return formatDelta(value);
  }

  scoreClass(value: number | null): string {
    return scoreBadgeClass(value, 'shrink-0');
  }

  changeLabel(change: PageChange): string {
    return changeLabel(change);
  }

  changeClass(change: PageChange): string {
    return changeBadgeClass(change);
  }

  trendClass(trend: CheckTrend): string {
    return trendBadgeClass(trend);
  }
}
