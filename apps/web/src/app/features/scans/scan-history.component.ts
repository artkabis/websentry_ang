import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { DEFAULT_PAGE_SIZE, type ScanSort, type SiteSummary } from '@websentry/shared';
import { ScansApi } from '../../core/scans/scans.api';
import {
  ariaSortOf,
  EMPTY_FILTERS,
  filterIssues,
  filtersFromParams,
  filtersToQuery,
  hasActiveFilters,
  paramsFromFilters,
  toggleSort,
  type ScanFilterState,
} from './scan-filters';
import { formatScore, scoreBadgeClass, scoreLabelOf, siteRowSummary } from './scan-format';

/** Nombre de lignes du squelette — calqué sur une page pleine. */
const SKELETON_ROWS = 6;

/**
 * Historique des scans — vue par site.
 *
 * Un site (couple domaine + gamme) tient sur une ligne, résumée par sa session
 * la plus récente. C'est la question que pose l'équipe qualité en ouvrant
 * l'écran : « où en est ce client ? », et non « quelle page a été analysée à
 * 10 h 03 ? ».
 *
 * L'état de recherche vit dans l'URL : une recherche se partage, se met en
 * favori et survit à un rechargement. Le bouton « Précédent » du navigateur
 * défait le dernier filtre au lieu de quitter l'écran.
 */
@Component({
  selector: 'ws-scan-history',
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-6xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-slate-900">Historique des scans</h1>
          <p class="mt-1 text-sm text-slate-500">
            Un site par ligne, résumé par son audit le plus récent.
          </p>
        </div>
      </header>

      <!-- ── Filtres ─────────────────────────────────────────────────────── -->
      <form
        class="mt-6 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
        (ngSubmit)="applyDraft()"
      >
        <fieldset class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend class="sr-only">Filtres de recherche</legend>

          <label class="block">
            <span class="text-xs font-medium text-slate-600">Recherche</span>
            <input
              type="search"
              name="q"
              [ngModel]="draftQ()"
              (ngModelChange)="draftQ.set($event)"
              placeholder="domaine ou EPJ"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-slate-600">Gamme</span>
            <input
              type="text"
              name="gamme"
              [ngModel]="draftGamme()"
              (ngModelChange)="draftGamme.set($event)"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-slate-600">Analysé depuis le</span>
            <input
              type="date"
              name="dateFrom"
              [ngModel]="draftDateFrom()"
              (ngModelChange)="draftDateFrom.set($event)"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-slate-600">Jusqu'au</span>
            <input
              type="date"
              name="dateTo"
              [ngModel]="draftDateTo()"
              (ngModelChange)="draftDateTo.set($event)"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </fieldset>

        @if (issues().length > 0) {
          <ul class="mt-3 space-y-1" role="alert">
            @for (issue of issues(); track issue) {
              <li class="text-sm text-red-700">{{ issue }}</li>
            }
          </ul>
        }

        <div class="mt-3 flex items-center gap-2">
          <button
            type="submit"
            [disabled]="issues().length > 0"
            class="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Filtrer
          </button>
          @if (filtersActive()) {
            <button
              type="button"
              (click)="resetFilters()"
              class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              Réinitialiser
            </button>
          }
        </div>
      </form>

      <!-- ── Résultats ───────────────────────────────────────────────────── -->
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
        <!-- Squelette calqué sur la forme réelle du tableau : la mise en page
             ne saute pas quand les données arrivent. -->
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (row of skeleton; track row) {
            <div class="h-14 animate-pulse rounded-lg bg-slate-100"></div>
          }
        </div>
      } @else if (sites().length === 0) {
        <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
          @if (filtersActive()) {
            <p class="text-sm text-slate-600">Aucun site ne correspond à ces filtres.</p>
            <button
              type="button"
              (click)="resetFilters()"
              class="mt-3 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Effacer les filtres
            </button>
          } @else {
            <p class="text-sm text-slate-600">L'historique est vide.</p>
            <p class="mt-1 text-sm text-slate-500">
              Les audits apparaîtront ici dès le premier scan enregistré.
            </p>
          }
        </div>
      } @else {
        <div class="mt-3 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">
              Sites audités,
              {{
                total()
              }}
              au total
            </caption>
            <thead class="border-b border-slate-200 text-xs uppercase text-slate-500">
              <tr>
                @for (column of columns; track column.key) {
                  <th scope="col" class="px-4 py-2" [attr.aria-sort]="ariaSort(column.key)">
                    <button
                      type="button"
                      (click)="sortBy(column.key)"
                      class="inline-flex items-center gap-1 font-medium hover:text-slate-900"
                    >
                      {{ column.label }}
                      <span aria-hidden="true">{{ sortIndicator(column.key) }}</span>
                    </button>
                  </th>
                }
                <th scope="col" class="px-4 py-2">Pages</th>
                <th scope="col" class="px-4 py-2">Dernier audit</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (site of sites(); track site.siteId) {
                <tr class="hover:bg-slate-50">
                  <td class="px-4 py-3">
                    <a
                      routerLink="/historique/site"
                      [queryParams]="linkParams(site)"
                      [attr.aria-label]="summaryOf(site)"
                      class="font-medium text-brand-700 hover:underline"
                    >
                      {{ site.domain }}
                    </a>
                    @if (site.epj) {
                      <span class="ml-2 text-xs text-slate-400">{{ site.epj }}</span>
                    }
                  </td>
                  <td class="px-4 py-3">
                    <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {{ site.gamme ?? 'sans gamme' }}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <span [class]="scoreClass(site.avgScore)">
                      {{ score(site.avgScore) }}
                    </span>
                    <!-- Le libellé double la couleur : elle est invisible pour
                         un lecteur d'écran et ambiguë en cas de daltonisme. -->
                    <span class="sr-only">sur 5, {{ scoreLabel(site.avgScore) }}</span>
                  </td>
                  <td class="px-4 py-3 text-slate-600">{{ site.pageCount }}</td>
                  <td class="px-4 py-3 text-slate-600">
                    {{ site.lastScan | date: 'dd/MM/yyyy HH:mm' }}
                    <span class="block text-xs text-slate-400">
                      {{ site.sessionCount }} audit(s)
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (totalPages() > 1) {
          <nav class="mt-4 flex items-center justify-between" aria-label="Pagination">
            <button
              type="button"
              (click)="goToPage(filters().page - 1)"
              [disabled]="filters().page <= 1"
              class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page précédente
            </button>
            <span class="text-sm text-slate-500">
              Page {{ filters().page }} sur {{ totalPages() }}
            </span>
            <button
              type="button"
              (click)="goToPage(filters().page + 1)"
              [disabled]="filters().page >= totalPages()"
              class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page suivante
            </button>
          </nav>
        }
      }
    </main>
  `,
})
export class ScanHistoryComponent {
  private readonly api = inject(ScansApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly skeleton = Array.from({ length: SKELETON_ROWS }, (_, i) => i);

  readonly columns: ReadonlyArray<{ key: ScanSort; label: string }> = [
    { key: 'domain', label: 'Domaine' },
    { key: 'url', label: 'Gamme' },
    { key: 'score', label: 'Score moyen' },
  ];

  /**
   * Filtres lus depuis l'URL — source de vérité unique.
   *
   * Le composant ne garde PAS de copie : naviguer met l'URL à jour, le signal
   * la relit, et le chargement suit. Un état dupliqué finirait par diverger de
   * la barre d'adresse, et le bouton « Précédent » afficherait autre chose que
   * ce que l'URL annonce.
   */
  readonly filters = toSignal(
    this.route.queryParams.pipe(map(params => filtersFromParams(params as Record<string, string>))),
    { initialValue: EMPTY_FILTERS },
  );

  readonly sites = signal<SiteSummary[]>([]);
  readonly total = signal(0);
  readonly totalPages = signal(0);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  /**
   * Brouillon des champs de filtre — appliqué à la SOUMISSION, pas à la frappe.
   *
   * Ce sont des signaux et non de simples propriétés : les incohérences
   * (`issues`) en dérivent, et une propriété ordinaire ne déclencherait aucun
   * recalcul. L'avertissement n'apparaîtrait qu'au prochain rendu déclenché par
   * autre chose — c'est-à-dire, en pratique, jamais.
   */
  readonly draftQ = signal('');
  readonly draftGamme = signal('');
  readonly draftDateFrom = signal('');
  readonly draftDateTo = signal('');

  private lastLoadKey = '';

  readonly issues = computed(() =>
    filterIssues({
      ...this.filters(),
      q: this.draftQ(),
      gamme: this.draftGamme(),
      dateFrom: this.draftDateFrom(),
      dateTo: this.draftDateTo(),
    }),
  );

  readonly filtersActive = computed(() => hasActiveFilters(this.filters()));

  readonly statusMessage = computed(() => {
    if (this.loading()) return 'Chargement de l’historique…';
    if (this.error()) return 'Le chargement a échoué.';
    const count = this.total();
    if (count === 0) return 'Aucun site trouvé.';
    return `${count} site(s) trouvé(s).`;
  });

  constructor() {
    // Le chargement SUIT l'URL, via un effet et non un appel unique au
    // démarrage. C'est ce qui fait fonctionner le bouton « Précédent » du
    // navigateur : il change les paramètres sans reconstruire le composant, et
    // un chargement posé dans le constructeur laisserait l'écran afficher le
    // résultat de la recherche précédente sous une adresse qui en annonce une
    // autre.
    effect(() => {
      const filters = this.filters();
      this.draftQ.set(filters.q);
      this.draftGamme.set(filters.gamme);
      this.draftDateFrom.set(filters.dateFrom);
      this.draftDateTo.set(filters.dateTo);
      void this.load(filters);
    });
  }

  async load(filters: ScanFilterState = this.filters()): Promise<void> {
    const key = JSON.stringify(filters);
    this.lastLoadKey = key;

    this.loading.set(true);
    this.error.set(null);

    try {
      const result = await this.api.listSites(filtersToQuery(filters, DEFAULT_PAGE_SIZE));
      // Une réponse plus lente qu'une navigation suivante ne doit pas écraser
      // l'affichage courant : on ignore ce qui n'est plus la requête en cours.
      if (this.lastLoadKey !== key) return;
      this.sites.set(result.sites);
      this.total.set(result.total);
      this.totalPages.set(result.pages);
    } catch {
      if (this.lastLoadKey !== key) return;
      this.error.set('Impossible de charger l’historique des scans.');
      this.sites.set([]);
    } finally {
      if (this.lastLoadKey === key) this.loading.set(false);
    }
  }

  reload(): void {
    void this.load();
  }

  applyDraft(): void {
    void this.navigate({
      ...this.filters(),
      q: this.draftQ().trim(),
      gamme: this.draftGamme().trim(),
      dateFrom: this.draftDateFrom(),
      dateTo: this.draftDateTo(),
      // Tout changement de filtre ramène en page 1 : rester page 4 afficherait
      // un extrait arbitraire d'un résultat qui n'a plus rien à voir.
      page: 1,
    });
  }

  resetFilters(): void {
    void this.navigate({
      ...EMPTY_FILTERS,
      sort: this.filters().sort,
      order: this.filters().order,
    });
  }

  sortBy(column: ScanSort): void {
    void this.navigate(toggleSort(this.filters(), column));
  }

  goToPage(page: number): void {
    void this.navigate({ ...this.filters(), page });
  }

  private async navigate(filters: ScanFilterState): Promise<void> {
    // Naviguer suffit : l'effet ci-dessus relit l'URL et relance le chargement.
    // Recharger ici EN PLUS doublerait chaque requête.
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsFromFilters(filters),
      // Les paramètres sont REMPLACÉS et non fusionnés : sans quoi un filtre
      // effacé resterait dans l'URL et continuerait de s'appliquer.
      queryParamsHandling: 'replace',
    });
  }

  ariaSort(column: ScanSort): string {
    return ariaSortOf(this.filters(), column);
  }

  sortIndicator(column: ScanSort): string {
    if (this.filters().sort !== column) return '';
    return this.filters().order === 'asc' ? '▲' : '▼';
  }

  score(value: number | null): string {
    return formatScore(value);
  }

  scoreLabel(value: number | null): string {
    return scoreLabelOf(value);
  }

  scoreClass(value: number | null): string {
    return scoreBadgeClass(value);
  }

  summaryOf(site: SiteSummary): string {
    return siteRowSummary(site);
  }

  /**
   * Coordonnées du site dans l'URL de détail.
   *
   * `gamme` n'est transmise QUE lorsqu'elle existe : un `gamme=` vide dans
   * l'adresse désignerait la chaîne vide, là où son absence désigne le site
   * sans gamme — deux choses que l'API distingue.
   */
  linkParams(site: SiteSummary): Record<string, string> {
    return site.gamme ? { domain: site.domain, gamme: site.gamme } : { domain: site.domain };
  }
}
