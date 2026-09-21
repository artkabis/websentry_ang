import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MAX_BATCH_URLS, type SitemapEntry } from '@websentry/shared';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { BATCH_URLS_STATE } from './batch-handoff';

/** Phase du parcours — une seule à l'écran à la fois. */
type Phase = 'idle' | 'detecting' | 'parsing' | 'ready' | 'error';

/**
 * Découverte des pages d'un site par son sitemap.
 *
 * L'écran répond à une question précise : « quelles pages analyser ? ». Il ne
 * lance donc rien lui-même — il constitue une SÉLECTION et la verse à l'écran
 * de lot, qui sait déjà suivre un flux et afficher des rapports. Dupliquer ce
 * suivi ici aurait fait deux implémentations à tenir.
 *
 * La sélection voyage par l'état de navigation et non par l'adresse : deux
 * cents URL ne tiennent pas dans une barre d'adresse, et les y mettre
 * produirait un lien intransmissible. L'écran de lot préremplit sa saisie, qui
 * reste modifiable — c'est ce qui rend le passage de relais lisible.
 */
@Component({
  selector: 'ws-sitemap',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900">Découvrir les pages d'un site</h1>
        <p class="mt-1 text-sm text-slate-500">
          Le sitemap est lu, les pages sont listées, et la sélection part vers
          <a routerLink="/analyse/lot" class="text-brand-700 hover:underline">l'analyse de lot</a>.
        </p>
      </header>

      <form class="mt-6 flex flex-wrap gap-2" (ngSubmit)="detect()">
        <label class="min-w-0 flex-1">
          <span class="sr-only">Adresse du site ou du sitemap</span>
          <input
            type="url"
            name="url"
            [ngModel]="url()"
            (ngModelChange)="url.set($event)"
            placeholder="https://exemple.fr/ ou https://exemple.fr/sitemap.xml"
            required
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          [disabled]="!canDetect()"
          class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ phase() === 'detecting' || phase() === 'parsing' ? 'Lecture…' : 'Lire le sitemap' }}
        </button>
      </form>

      <fieldset class="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-600">
        <legend class="sr-only">Options de lecture</legend>
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            name="priority"
            [ngModel]="onlyPrioritized()"
            (ngModelChange)="onlyPrioritized.set($event)"
            class="size-4 rounded border-slate-300"
          />
          N'afficher que les pages portant une priorité déclarée
        </label>
        <label class="flex items-center gap-2">
          Plafond
          <input
            type="number"
            name="limit"
            min="1"
            [max]="maxUrls"
            [ngModel]="limit()"
            (ngModelChange)="limit.set($event)"
            class="w-20 rounded-lg border border-slate-300 px-2 py-1"
          />
        </label>
      </fieldset>

      <p role="status" aria-live="polite" class="mt-4 text-sm text-slate-500">
        {{ statusMessage() }}
      </p>

      @if (error(); as message) {
        <div class="mt-3 rounded-lg bg-red-50 p-4" role="alert">
          <p class="text-sm text-red-700">{{ message }}</p>
          <button
            type="button"
            (click)="detect()"
            class="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Réessayer
          </button>
        </div>
      } @else if (phase() === 'detecting' || phase() === 'parsing') {
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (row of skeleton; track row) {
            <div class="h-10 animate-pulse rounded-lg bg-slate-100"></div>
          }
        </div>
      } @else if (phase() === 'ready') {
        @if (entries().length === 0) {
          <div class="mt-3 rounded-xl bg-white p-8 text-center ring-1 ring-slate-200">
            <p class="text-sm text-slate-600">
              Ce sitemap ne contient aucune page exploitable.
              @if (onlyPrioritized()) {
                Le filtre sur la priorité déclarée en écarte peut-être la totalité.
              }
            </p>
            <a
              routerLink="/analyse"
              class="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline"
            >
              Analyser une page précise
            </a>
          </div>
        } @else {
          @if (truncated()) {
            <p class="mt-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {{ discovered() }} page(s) découverte(s), {{ entries().length }} retenue(s) par le
              plafond. Augmentez-le pour en voir davantage.
            </p>
          }

          <div class="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              (click)="toggleAll()"
              class="rounded-lg px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {{ allSelected() ? 'Tout désélectionner' : 'Tout sélectionner' }}
            </button>
            <span class="text-sm text-slate-500">{{ selectionHint() }}</span>
            <button
              type="button"
              (click)="sendToBatch()"
              [disabled]="selected().size === 0"
              class="ml-auto rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Analyser la sélection
            </button>
          </div>

          <ul class="mt-3 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            @for (entry of entries(); track entry.url) {
              <li class="flex items-center gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  [id]="'url-' + entry.url"
                  [checked]="selected().has(entry.url)"
                  (change)="toggle(entry.url)"
                  class="size-4 rounded border-slate-300"
                />
                <label [for]="'url-' + entry.url" class="min-w-0 flex-1 cursor-pointer">
                  <span class="block truncate text-sm text-slate-800">{{ entry.url }}</span>
                  <span class="block text-xs text-slate-500">
                    @if (entry.priority !== null) {
                      priorité {{ entry.priority }}
                    }
                    @if (entry.lastmod) {
                      · modifiée le {{ entry.lastmod }}
                    }
                  </span>
                </label>
              </li>
            }
          </ul>
        }
      }
    </main>
  `,
})
export class SitemapComponent {
  private readonly api = inject(AnalysisApi);
  private readonly router = inject(Router);

  readonly maxUrls = MAX_BATCH_URLS;
  readonly skeleton = [0, 1, 2];

  readonly url = signal('');
  readonly limit = signal(50);
  readonly onlyPrioritized = signal(false);
  readonly phase = signal<Phase>('idle');
  readonly error = signal<string | null>(null);
  readonly entries = signal<SitemapEntry[]>([]);
  readonly discovered = signal(0);
  readonly truncated = signal(false);
  readonly selected = signal<ReadonlySet<string>>(new Set());

  readonly canDetect = computed(
    () =>
      this.url().trim().length > 0 && this.phase() !== 'detecting' && this.phase() !== 'parsing',
  );

  readonly allSelected = computed(
    () => this.entries().length > 0 && this.selected().size === this.entries().length,
  );

  readonly selectionHint = computed(() => {
    const count = this.selected().size;
    if (count === 0) return 'Aucune page sélectionnée.';
    return `${count} page(s) sur ${this.entries().length} sélectionnée(s).`;
  });

  readonly statusMessage = computed(() => {
    switch (this.phase()) {
      case 'detecting':
        return 'Recherche du sitemap…';
      case 'parsing':
        return 'Lecture du sitemap…';
      case 'ready':
        return `${this.entries().length} page(s) listée(s) sur ${this.discovered()} découverte(s).`;
      case 'error':
        return 'Le sitemap n’a pas pu être lu.';
      default:
        return 'Saisissez l’adresse d’un site ou de son sitemap.';
    }
  });

  /**
   * Trouve le sitemap puis le lit.
   *
   * L'adresse saisie peut être celle du site — le sitemap est alors cherché aux
   * endroits d'usage — ou celle du sitemap lui-même, qu'on lit directement.
   * Demander à l'utilisateur de distinguer les deux cas serait lui faire faire
   * le travail que l'API sait déjà faire.
   */
  async detect(): Promise<void> {
    const url = this.url().trim();
    if (!url) return;

    this.phase.set('detecting');
    this.error.set(null);
    this.entries.set([]);
    this.selected.set(new Set());

    try {
      const sitemapUrl = url.endsWith('.xml') ? url : ((await this.api.detectSitemap(url)) ?? url);

      this.phase.set('parsing');
      const result = await this.api.parseSitemap(
        sitemapUrl,
        this.boundedLimit(),
        this.onlyPrioritized(),
      );

      this.entries.set(result.entries);
      this.discovered.set(result.discovered);
      this.truncated.set(result.truncated);
      // Tout est sélectionné d'emblée : on vient lire un sitemap pour analyser
      // ses pages, pas pour les cocher une à une.
      this.selected.set(new Set(result.entries.map(entry => entry.url)));
      this.phase.set('ready');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Le sitemap n’a pas pu être lu.');
      this.phase.set('error');
    }
  }

  toggle(url: string): void {
    this.selected.update(current => {
      const next = new Set(current);
      if (!next.delete(url)) next.add(url);
      return next;
    });
  }

  toggleAll(): void {
    this.selected.set(
      this.allSelected() ? new Set() : new Set(this.entries().map(entry => entry.url)),
    );
  }

  /**
   * Verse la sélection à l'écran de lot.
   *
   * Par l'état de navigation, et non par l'adresse : deux cents URL n'y
   * tiennent pas. L'écran de lot préremplit sa saisie, qui reste modifiable.
   */
  sendToBatch(): void {
    const urls = this.entries()
      .map(entry => entry.url)
      .filter(url => this.selected().has(url));
    if (urls.length === 0) return;

    void this.router.navigate(['/analyse/lot'], { state: { [BATCH_URLS_STATE]: urls } });
  }

  /** Le plafond reste dans les bornes du contrat : l'API refuserait au-delà. */
  private boundedLimit(): number {
    const value = Math.trunc(this.limit());
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(value, MAX_BATCH_URLS);
  }
}
