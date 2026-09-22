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
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import type { AuditEntryView } from '@websentry/shared';
import { AuditApi } from '../../core/users/audit.api';
import {
  FAMILLES_ACTION,
  FILTRES_AUDIT_VIDES,
  filtresAuditActifs,
  filtresAuditDepuisParams,
  filtresAuditVersRequete,
  incoherencesAudit,
  libelleAction,
  paramsDepuisFiltresAudit,
  TAILLE_PAGE_AUDIT,
  type AuditFilterState,
} from './audit-filters';

const LIGNES_SQUELETTE = 10;

/**
 * Journal d'audit — lecture seule.
 *
 * Aucun bouton de purge ni de correction : le journal est append-only côté
 * serveur, et offrir un geste que l'API ne porte pas serait mentir sur ce que
 * l'outil garantit.
 *
 * Le détail d'une action est replié par défaut : sa forme dépend de l'action, et
 * l'étaler transformerait le tableau en mur de JSON.
 */
@Component({
  selector: 'ws-audit-log',
  standalone: true,
  imports: [DatePipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-6xl px-4 py-10">
      <header>
        <h1 class="text-2xl font-semibold text-content">Journal d'audit</h1>
        <p class="mt-1 text-sm text-content-subtle">
          Qui a fait quoi, quand, depuis quelle adresse. Rien ne s'y efface ni ne s'y corrige.
        </p>
      </header>

      <form
        class="mt-6 rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line"
        (ngSubmit)="appliquerBrouillon()"
      >
        <fieldset class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend class="sr-only">Filtres du journal</legend>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Acteur</span>
            <input
              type="search"
              name="acteur"
              [ngModel]="brouillonActeur()"
              (ngModelChange)="brouillonActeur.set($event)"
              placeholder="identifiant ou nom"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Famille d'actions</span>
            <select
              name="action"
              [ngModel]="brouillonAction()"
              (ngModelChange)="brouillonAction.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Toutes les actions</option>
              @for (famille of familles; track famille.prefixe) {
                <option [value]="famille.prefixe">{{ famille.libelle }}</option>
              }
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Depuis le</span>
            <input
              type="date"
              name="du"
              [ngModel]="brouillonDu()"
              (ngModelChange)="brouillonDu.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Jusqu'au</span>
            <input
              type="date"
              name="au"
              [ngModel]="brouillonAu()"
              (ngModelChange)="brouillonAu.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>
        </fieldset>

        @if (incoherences().length > 0) {
          <ul class="mt-3 space-y-1" role="alert">
            @for (souci of incoherences(); track souci) {
              <li class="text-sm text-danger-content">{{ souci }}</li>
            }
          </ul>
        }

        <div class="mt-3 flex items-center gap-2">
          <button
            type="submit"
            [disabled]="incoherences().length > 0"
            class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Filtrer
          </button>
          @if (filtresPoses()) {
            <button
              type="button"
              (click)="reinitialiser()"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken"
            >
              Réinitialiser
            </button>
          }
        </div>
      </form>

      <p role="status" aria-live="polite" class="mt-6 text-sm text-content-subtle">
        {{ messageEtat() }}
      </p>

      @if (erreur(); as message) {
        <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
          <button
            type="button"
            (click)="recharger()"
            class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
          >
            Réessayer
          </button>
        </div>
      } @else if (chargement()) {
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (ligne of squelette; track ligne) {
            <div class="h-12 animate-pulse rounded-lg bg-sunken"></div>
          }
        </div>
      } @else if (entrees().length === 0) {
        <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
          @if (filtresPoses()) {
            <p class="text-sm text-content-muted">Aucune trace ne correspond à ces filtres.</p>
            <button
              type="button"
              (click)="reinitialiser()"
              class="mt-3 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Effacer les filtres
            </button>
          } @else {
            <p class="text-sm text-content-muted">Le journal est vide.</p>
            <p class="mt-1 text-sm text-content-subtle">
              Les connexions et les écritures y apparaîtront au fil de l'usage.
            </p>
          }
        </div>
      } @else {
        <div class="mt-3 overflow-x-auto rounded-xl bg-panel shadow-sm ring-1 ring-line">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">
              Traces d'audit,
              {{
                total()
              }}
              au total, la plus récente en premier
            </caption>
            <thead class="border-b border-line text-xs uppercase text-content-subtle">
              <tr>
                <th scope="col" class="px-4 py-2">Quand</th>
                <th scope="col" class="px-4 py-2">Qui</th>
                <th scope="col" class="px-4 py-2">Quoi</th>
                <th scope="col" class="px-4 py-2">Sur quoi</th>
                <th scope="col" class="px-4 py-2">Adresse</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (trace of entrees(); track trace.id) {
                <tr class="align-top hover:bg-sunken">
                  <td class="whitespace-nowrap px-4 py-3 text-content-muted">
                    {{ trace.createdAt | date: 'dd/MM/yyyy HH:mm:ss' }}
                  </td>
                  <td class="px-4 py-3">
                    <span class="font-medium text-content">
                      {{ trace.actorName ?? 'système' }}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <span class="text-content">{{ nomAction(trace.action) }}</span>
                    <code class="block text-xs text-content-subtle">{{ trace.action }}</code>
                    @if (trace.details) {
                      <!-- Replié par défaut : la forme du détail dépend de
                           l'action, l'étaler ferait un mur de JSON. -->
                      <details class="mt-1">
                        <summary class="cursor-pointer text-xs text-brand-text hover:underline">
                          Détail
                        </summary>
                        <pre
                          class="mt-1 overflow-x-auto rounded-lg bg-sunken p-2 text-xs text-content-muted"
                          >{{ detail(trace) }}</pre>
                      </details>
                    }
                  </td>
                  <td class="px-4 py-3 text-content-muted">
                    @if (trace.targetId) {
                      <code class="text-xs">{{ trace.targetId }}</code>
                      @if (trace.targetType) {
                        <span class="block text-xs text-content-subtle">{{
                          trace.targetType
                        }}</span>
                      }
                    } @else {
                      <span class="text-xs text-content-subtle">—</span>
                    }
                  </td>
                  <td class="px-4 py-3 text-content-muted">
                    <code class="text-xs">{{ trace.ipAddress ?? '—' }}</code>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (pages() > 1) {
          <nav class="mt-4 flex items-center justify-between" aria-label="Pagination">
            <button
              type="button"
              (click)="allerALaPage(filtres().page - 1)"
              [disabled]="filtres().page <= 1"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page précédente
            </button>
            <span class="text-sm text-content-subtle">
              Page {{ filtres().page }} sur {{ pages() }}
            </span>
            <button
              type="button"
              (click)="allerALaPage(filtres().page + 1)"
              [disabled]="filtres().page >= pages()"
              class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Page suivante
            </button>
          </nav>
        }
      }
    </main>
  `,
})
export class AuditLogComponent {
  private readonly api = inject(AuditApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly squelette = Array.from({ length: LIGNES_SQUELETTE }, (_, i) => i);
  readonly familles = FAMILLES_ACTION;

  readonly filtres = toSignal(
    this.route.queryParams.pipe(map(p => filtresAuditDepuisParams(p as Record<string, string>))),
    { initialValue: FILTRES_AUDIT_VIDES },
  );

  readonly entrees = signal<AuditEntryView[]>([]);
  readonly total = signal(0);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);

  readonly brouillonActeur = signal('');
  readonly brouillonAction = signal('');
  readonly brouillonDu = signal('');
  readonly brouillonAu = signal('');

  private derniereCle = '';

  readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / TAILLE_PAGE_AUDIT)));
  readonly filtresPoses = computed(() => filtresAuditActifs(this.filtres()));

  readonly incoherences = computed(() =>
    incoherencesAudit({
      ...this.filtres(),
      actor: this.brouillonActeur(),
      action: this.brouillonAction(),
      from: this.brouillonDu(),
      to: this.brouillonAu(),
    }),
  );

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement du journal…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const nombre = this.total();
    if (nombre === 0) return 'Aucune trace trouvée.';
    return `${nombre} trace(s) trouvée(s).`;
  });

  constructor() {
    effect(() => {
      const filtres = this.filtres();
      this.brouillonActeur.set(filtres.actor);
      this.brouillonAction.set(filtres.action);
      this.brouillonDu.set(filtres.from);
      this.brouillonAu.set(filtres.to);
      void this.charger(filtres);
    });
  }

  async charger(filtres: AuditFilterState = this.filtres()): Promise<void> {
    const cle = JSON.stringify(filtres);
    this.derniereCle = cle;

    this.chargement.set(true);
    this.erreur.set(null);

    try {
      const resultat = await this.api.list(filtresAuditVersRequete(filtres, TAILLE_PAGE_AUDIT));
      if (this.derniereCle !== cle) return;
      this.entrees.set(resultat.entries);
      this.total.set(resultat.total);
    } catch {
      if (this.derniereCle !== cle) return;
      this.erreur.set('Impossible de charger le journal d’audit.');
      this.entrees.set([]);
    } finally {
      if (this.derniereCle === cle) this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  appliquerBrouillon(): void {
    if (this.incoherences().length > 0) return;
    void this.naviguer({
      ...this.filtres(),
      actor: this.brouillonActeur().trim(),
      action: this.brouillonAction(),
      from: this.brouillonDu(),
      to: this.brouillonAu(),
      page: 1,
    });
  }

  reinitialiser(): void {
    void this.naviguer(FILTRES_AUDIT_VIDES);
  }

  allerALaPage(page: number): void {
    void this.naviguer({ ...this.filtres(), page });
  }

  nomAction(action: string): string {
    return libelleAction(action);
  }

  /** Détail lisible — deux espaces d'indentation, pas une ligne compacte. */
  detail(trace: AuditEntryView): string {
    return JSON.stringify(trace.details, null, 2);
  }

  private naviguer(filtres: AuditFilterState): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsDepuisFiltresAudit(filtres),
    });
  }
}
