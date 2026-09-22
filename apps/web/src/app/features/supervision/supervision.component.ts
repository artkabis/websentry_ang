import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { EtatComposant, Supervision } from '@websentry/shared';
import { SupervisionApi } from '../../core/supervision/supervision.api';
import {
  classeEtat,
  formatDuree,
  formatNombre,
  formatUptime,
  libelleEtat,
  resumeGlobal,
} from './supervision-format';

/**
 * Supervision — l'état réel de l'instance.
 *
 * L'écran se lit en un coup d'œil ou il ne sert pas : le verdict global est en
 * tête, et le détail derrière. Rien ne s'y pilote — l'API n'offre aucune
 * commande, et un bouton qui échouerait serait pire que son absence.
 *
 * Le rafraîchissement est MANUEL. Un rechargement automatique donnerait
 * l'illusion d'une surveillance continue alors que personne ne regarde l'écran
 * la nuit ; la vraie alerte est affaire d'exploitation, pas de navigateur.
 */
@Component({
  selector: 'ws-supervision',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Supervision</h1>
          <p class="mt-1 text-sm text-content-subtle">
            Ce que l'instance fait réellement, au-delà de ce qu'elle journalise.
          </p>
        </div>
        <button
          type="button"
          (click)="recharger()"
          [disabled]="chargement()"
          class="rounded-lg border border-field px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:opacity-50"
        >
          @if (chargement()) {
            Relevé en cours…
          } @else {
            Rafraîchir
          }
        </button>
      </header>

      <p role="status" aria-live="polite" class="mt-6 text-sm text-content-subtle">
        {{ messageEtat() }}
      </p>

      <!-- L'échec SURMONTE le relevé, il ne le remplace pas : vider l'écran
           ferait croire à une panne plus grave que la panne réelle, alors que
           le dernier relevé connu reste la meilleure information disponible. -->
      @if (erreur(); as message) {
        <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
          <p class="mt-1 text-xs text-danger-content">
            Le relevé affiché est le dernier obtenu ; il peut ne plus être à jour.
          </p>
          <button
            type="button"
            (click)="recharger()"
            class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
          >
            Réessayer
          </button>
        </div>
      }

      @if (releve() === null) {
        @if (!erreur()) {
          <div class="mt-3 space-y-3" aria-hidden="true">
            <div class="h-24 animate-pulse rounded-xl bg-sunken"></div>
            <div class="h-40 animate-pulse rounded-xl bg-sunken"></div>
          </div>
        }
      } @else if (releve(); as etat) {
        <!-- ── Verdict ─────────────────────────────────────────────────── -->
        <section class="mt-3 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
          <div class="flex flex-wrap items-center gap-3">
            <span [class]="classe(etat.etat)">{{ nomEtat(etat.etat) }}</span>
            <p class="text-base text-content">{{ resume(etat.etat) }}</p>
          </div>
          <p class="mt-2 text-xs text-content-subtle">
            Relevé du {{ etat.releveA | date: 'dd/MM/yyyy HH:mm:ss' }} · version
            {{ etat.instance.version }} · {{ etat.instance.environnement }} · en service depuis
            {{ uptime(etat.instance.uptimeSec) }}
          </p>
        </section>

        <!-- ── Composants ──────────────────────────────────────────────── -->
        <h2 class="mt-6 text-base font-medium text-content">Composants</h2>
        <ul class="mt-2 space-y-2">
          <li class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <h3 class="text-sm font-medium text-content">Base de données</h3>
              <span [class]="classe(etat.base.etat)">{{ nomEtat(etat.base.etat) }}</span>
            </div>
            <p class="mt-1 text-sm text-content-muted">{{ etat.base.message }}</p>
          </li>

          <li class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <h3 class="text-sm font-medium text-content">Pool d'analyse</h3>
              <span [class]="classe(etat.poolAnalyse.etat)">
                {{ nomEtat(etat.poolAnalyse.etat) }}
              </span>
            </div>
            <p class="mt-1 text-sm text-content-muted">{{ etat.poolAnalyse.message }}</p>
          </li>

          <li class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <h3 class="text-sm font-medium text-content">Rétention des rapports</h3>
              <span [class]="classe(etat.retention.etat)">
                {{ nomEtat(etat.retention.etat) }}
              </span>
            </div>
            <p class="mt-1 text-sm text-content-muted">{{ etat.retention.message }}</p>

            @if (etat.retention.dernierPassage; as passage) {
              <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt class="text-content-subtle">Compressés</dt>
                  <dd class="text-content">{{ nombre(passage.compresses) }}</dd>
                </div>
                <div>
                  <dt class="text-content-subtle">Purgés</dt>
                  <dd class="text-content">{{ nombre(passage.purges) }}</dd>
                </div>
                <div>
                  <dt class="text-content-subtle">En attente</dt>
                  <dd class="text-content">{{ nombre(passage.restants) }}</dd>
                </div>
                <div>
                  <dt class="text-content-subtle">Durée</dt>
                  <dd class="text-content">{{ duree(passage.dureeMs) }}</dd>
                </div>
              </dl>
              <p class="mt-1 text-xs text-content-subtle">
                Dernier passage le {{ passage.termineA | date: 'dd/MM/yyyy HH:mm' }}
              </p>
            }
          </li>
        </ul>

        <!-- ── Volumétrie ──────────────────────────────────────────────── -->
        <h2 class="mt-6 text-base font-medium text-content">Volumétrie</h2>
        @if (etat.volumetrie; as volumes) {
          <dl class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <dt class="text-xs text-content-subtle">Pages analysées (24 h)</dt>
              <dd class="mt-1 text-xl font-semibold text-content">
                {{ nombre(volumes.scans24h) }}
              </dd>
            </div>
            <div class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <dt class="text-xs text-content-subtle">Pages analysées (7 j)</dt>
              <dd class="mt-1 text-xl font-semibold text-content">
                {{ nombre(volumes.scans7j) }}
              </dd>
            </div>
            <div class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <dt class="text-xs text-content-subtle">Comptes actifs</dt>
              <dd class="mt-1 text-xl font-semibold text-content">
                {{ nombre(volumes.comptesActifs) }}
              </dd>
            </div>
            <div class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <dt class="text-xs text-content-subtle">Retours ouverts</dt>
              <dd class="mt-1 text-xl font-semibold text-content">
                {{ nombre(volumes.retoursOuverts) }}
              </dd>
            </div>
          </dl>
        } @else {
          <!-- On n'invente pas de zéros : ils passeraient pour une instance
               au repos alors que la mesure a échoué. -->
          <p class="mt-2 rounded-xl bg-sunken p-4 text-sm text-content-muted">
            Indisponible — la volumétrie se lit en base, qui ne répond pas.
          </p>
        }
      }
    </main>
  `,
})
export class SupervisionComponent {
  private readonly api = inject(SupervisionApi);

  readonly releve = signal<Supervision | null>(null);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);

  /**
   * Ce qu'annonce la région vocale.
   *
   * Volontairement DIFFÉRENT de la phrase de la carte : répéter mot pour mot
   * ce qui est déjà affiché juste en dessous fait entendre deux fois la même
   * chose à un lecteur d'écran, et encombre l'écran des autres.
   */
  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Relevé en cours…';
    if (this.erreur()) return 'Le relevé a échoué.';
    const etat = this.releve();
    return etat ? `État relevé : ${libelleEtat(etat.etat)}.` : '';
  });

  constructor() {
    void this.charger();
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      this.releve.set(await this.api.releve());
    } catch {
      // On conserve le relevé précédent : un écran vidé par un échec réseau
      // ferait croire à une panne plus grave que la panne réelle.
      this.erreur.set('Impossible de relever l’état de l’instance.');
    } finally {
      this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  nomEtat(etat: EtatComposant): string {
    return libelleEtat(etat);
  }

  resume(etat: EtatComposant): string {
    return resumeGlobal(etat);
  }

  classe(etat: EtatComposant): string {
    return classeEtat(etat);
  }

  uptime(secondes: number): string {
    return formatUptime(secondes);
  }

  nombre(valeur: number): string {
    return formatNombre(valeur);
  }

  duree(ms: number): string {
    return formatDuree(ms);
  }
}
