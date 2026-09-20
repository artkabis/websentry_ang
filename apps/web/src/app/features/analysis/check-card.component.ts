import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { CheckItem, CheckResult } from '@websentry/shared';
import { StatusBadgeComponent } from './status-badge.component';
import { locatorUrl, sortItems } from './report-view';

/**
 * Un critère — niveau 3 de lecture.
 *
 * Replié par défaut : la ligne dit le statut, le titre et le résumé, ce qui
 * suffit à décider si l'on ouvre. Déplié, elle donne les recommandations
 * d'abord — ce qu'on vient chercher quand on corrige — puis le détail des
 * points de contrôle, les plus graves en tête.
 *
 * L'ouverture est un `<button>` portant `aria-expanded` et non un `<div>`
 * cliquable : c'est ce qui la rend actionnable au clavier sans un seul
 * gestionnaire d'événement supplémentaire.
 */
@Component({
  selector: 'ws-check-card',
  standalone: true,
  imports: [StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="border-b border-slate-100 last:border-0">
      <h3>
        <button
          type="button"
          (click)="toggle()"
          [attr.aria-expanded]="expanded()"
          [attr.aria-controls]="panelId()"
          class="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
        >
          <ws-status-badge [status]="check().status" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-slate-900">{{ check().checkTitle }}</span>
            <span class="block text-xs text-slate-500">{{ check().summary }}</span>
          </span>
          <span class="shrink-0 text-xs text-slate-400" aria-hidden="true">
            {{ expanded() ? '▲' : '▼' }}
          </span>
        </button>
      </h3>

      @if (expanded()) {
        <div [id]="panelId()" class="px-4 pb-4">
          @if (check().recommendations.length > 0) {
            <!-- Les recommandations AVANT le détail : c'est ce qu'on vient
                 chercher quand on ouvre un critère en échec. -->
            <div class="rounded-lg bg-brand-50 p-3">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-brand-700">
                Que faire
              </h4>
              <ul class="mt-1 space-y-1">
                @for (reco of check().recommendations; track reco) {
                  <li class="text-sm text-slate-700">{{ reco }}</li>
                }
              </ul>
            </div>
          }

          @if (visibleItems().length > 0) {
            <ul class="mt-3 space-y-2">
              @for (item of visibleItems(); track $index) {
                <li class="rounded-lg bg-slate-50 p-3">
                  <div class="flex items-start gap-2">
                    <ws-status-badge [status]="item.status" />
                    <span class="min-w-0 flex-1 text-sm text-slate-800">{{ item.label }}</span>
                    @if (linkFor(item); as href) {
                      <!-- Le navigateur surligne lui-même le passage : aucun
                           script, aucune dépendance au gabarit du site. -->
                      <a
                        [href]="href"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="shrink-0 text-xs font-medium text-brand-700 hover:underline"
                      >
                        Voir dans la page
                      </a>
                    }
                  </div>
                  @if (item.value !== undefined && item.value !== null) {
                    <p class="mt-1 truncate text-xs text-slate-500">{{ item.value }}</p>
                  }
                  @if (item.detail) {
                    <p class="mt-1 text-xs text-slate-500">{{ item.detail }}</p>
                  }
                  @if (item.source) {
                    <pre
                      class="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100"
                    ><code>{{ item.source }}</code></pre>
                  }
                </li>
              }
            </ul>

            @if (extraItems() > 0) {
              <button
                type="button"
                (click)="showAllItems.set(true)"
                class="mt-2 text-xs font-medium text-brand-700 hover:underline"
              >
                Afficher les {{ extraItems() }} point(s) restant(s)
              </button>
            }
          }
        </div>
      }
    </div>
  `,
})
export class CheckCardComponent {
  readonly check = input.required<CheckResult>();
  /** URL analysée — base des liens « voir dans la page ». */
  readonly pageUrl = input.required<string>();

  readonly expanded = signal(false);
  readonly showAllItems = signal(false);

  /**
   * Points de contrôle affichés d'emblée.
   *
   * Un critère peut en porter des dizaines — quarante images sans `alt`, par
   * exemple. En montrer une poignée et proposer le reste évite de faire
   * dérouler l'utilisateur jusqu'à ce qu'il abandonne.
   */
  private static readonly PREVIEW_ITEMS = 8;

  readonly sortedItems = computed(() => sortItems(this.check().items));

  readonly visibleItems = computed(() =>
    this.showAllItems()
      ? this.sortedItems()
      : this.sortedItems().slice(0, CheckCardComponent.PREVIEW_ITEMS),
  );

  readonly extraItems = computed(() => this.sortedItems().length - this.visibleItems().length);

  readonly panelId = computed(() => `critere-${this.check().checkId}`);

  toggle(): void {
    this.expanded.update(open => !open);
  }

  linkFor(item: CheckItem): string | null {
    return item.locator ? locatorUrl(this.pageUrl(), item.locator) : null;
  }
}
