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
import { RouterLink } from '@angular/router';
import type { SessionPage, SessionReport } from '@websentry/shared';
import { ScansApi } from '../../core/scans/scans.api';
import { formatScore, reportAvailable, reportStateLabel, scoreBadgeClass } from './scan-format';

/**
 * Pages d'un audit.
 *
 * C'était le chaînon manquant de l'historique : on pouvait atteindre un site,
 * puis ses audits successifs, puis leur comparaison — mais jamais le rapport
 * d'une page. L'API le servait, aucun écran n'y menait.
 *
 * Les pages sont triées par score CROISSANT : celles qui demandent du travail
 * se lisent en premier, et non celles qui vont bien. Les pages sans score —
 * une récupération en échec — viennent avant tout le reste : elles n'ont pas
 * été mesurées, c'est plus grave qu'une mauvaise note.
 */
@Component({
  selector: 'ws-session-pages',
  standalone: true,
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-5xl px-4 py-10">
      <nav class="text-sm">
        <a routerLink="/historique" class="text-brand-700 hover:underline">
          ← Retour à l'historique
        </a>
      </nav>

      @if (session(); as audit) {
        <header class="mt-4">
          <h1 class="text-2xl font-semibold text-slate-900">{{ audit.domain }}</h1>
          <p class="mt-1 text-sm text-slate-500">
            Audit du {{ audit.analyzedAt | date: 'dd/MM/yyyy HH:mm' }} ·
            {{ audit.pageCount }} page(s) · score moyen {{ score(audit.avgScore) }}
            @if (audit.gamme) {
              · gamme {{ audit.gamme }}
            }
          </p>
        </header>
      }

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
            <div class="h-14 animate-pulse rounded-lg bg-slate-100"></div>
          }
        </div>
      } @else if (pages().length === 0) {
        <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
          <p class="text-sm text-slate-600">Cet audit ne contient aucune page.</p>
          <a
            routerLink="/analyse"
            class="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline"
          >
            Lancer une nouvelle analyse
          </a>
        </div>
      } @else {
        @if (session()?.truncated) {
          <p class="mt-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Cet audit compte plus de pages que l'affichage n'en restitue : seules les
            {{ pages().length }} premières sont listées.
          </p>
        }

        <ul class="mt-3 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          @for (page of pages(); track page.id) {
            <li>
              <a
                [routerLink]="['/historique/page', page.id]"
                class="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 focus-visible:bg-slate-50"
                [attr.aria-label]="rowSummary(page)"
              >
                <span [class]="badge(page.globalScore)">{{ score(page.globalScore) }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-slate-800">{{ page.url }}</span>
                  <span class="block text-xs text-slate-500">
                    {{ page.analyzedAt | date: 'dd/MM/yyyy HH:mm' }}
                    @if (page.statusCode !== null) {
                      · HTTP {{ page.statusCode }}
                    }
                    @if (!available(page.reportState)) {
                      · {{ stateLabel(page.reportState) }}
                    }
                    @if (page.error) {
                      · {{ page.error }}
                    }
                  </span>
                </span>
                <span class="text-xs text-slate-400" aria-hidden="true">voir le rapport →</span>
              </a>
            </li>
          }
        </ul>
      }
    </main>
  `,
})
export class SessionPagesComponent {
  private readonly api = inject(ScansApi);

  /** Identifiant lié par la route (`withComponentInputBinding`). */
  readonly sessionId = input.required<string>();

  readonly skeleton = [0, 1, 2];
  readonly session = signal<SessionReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    // Un `effect` et non un appel dans le constructeur : les entrées de route ne
    // sont pas encore résolues à la construction, et Angular RÉUTILISE le
    // composant d'un audit à l'autre — un chargement posé au constructeur ne se
    // rejouerait jamais, et l'écran montrerait les pages de l'audit précédent.
    effect(() => {
      const id = this.sessionId();
      void this.load(id);
    });
  }

  /** Pages triées : non mesurées d'abord, puis par score croissant. */
  readonly pages = computed(() => {
    const audit = this.session();
    if (!audit) return [];

    return [...audit.pages].sort((a, b) => {
      if (a.globalScore === null && b.globalScore === null) return a.url.localeCompare(b.url);
      if (a.globalScore === null) return -1;
      if (b.globalScore === null) return 1;
      return a.globalScore - b.globalScore || a.url.localeCompare(b.url);
    });
  });

  readonly statusMessage = computed(() => {
    if (this.loading()) return 'Chargement des pages de l’audit…';
    if (this.error()) return 'Les pages n’ont pas pu être chargées.';
    const count = this.pages().length;
    return count === 0 ? 'Aucune page dans cet audit.' : `${count} page(s) analysée(s).`;
  });

  async reload(): Promise<void> {
    await this.load(this.sessionId());
  }

  private async load(sessionId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      this.session.set(await this.api.session(sessionId));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Les pages n’ont pas pu être chargées.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Phrase de synthèse d'une ligne, pour les lecteurs d'écran.
   *
   * Une ligne faite de colonnes se lit mal cellule par cellule : celle-ci donne
   * l'essentiel d'un coup, sur le lien qui la porte.
   */
  rowSummary(page: SessionPage): string {
    const note =
      page.globalScore === null ? 'sans score' : `score ${formatScore(page.globalScore)}`;
    const etat = reportAvailable(page.reportState)
      ? 'rapport consultable'
      : reportStateLabel(page.reportState).toLowerCase();
    return `${page.url} — ${note}, ${etat}`;
  }

  score(value: number | null): string {
    return formatScore(value);
  }

  badge(value: number | null): string {
    return scoreBadgeClass(value);
  }

  available(state: SessionPage['reportState']): boolean {
    return reportAvailable(state);
  }

  stateLabel(state: SessionPage['reportState']): string {
    return reportStateLabel(state);
  }
}
