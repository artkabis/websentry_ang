import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import type { UsageGovernance, UsageOverview, UsagePeriod } from '@websentry/shared';
import { UsageApi } from '../../core/usage/usage.api';
import {
  anonymisationEnRetard,
  barresDeLaSerie,
  compteurMontrable,
  expliquerEtape,
  jourCourt,
  libelleEtape,
  libellePeriode,
  libelleRetention,
  partDuTunnel,
  periodeDepuisParams,
  PERIODES,
  paramsDepuisPeriode,
  resumerSerie,
} from './usage-format';

/**
 * Tunnel d'usage et registre de traitement.
 *
 * L'écran répond à deux questions qui ne se ressemblent pas : « l'outil
 * sert-il ? » et « que conservons-nous des gens qui s'en servent ? ». Les
 * mettre côte à côte est délibéré — une équipe qui regarde ses statistiques
 * d'usage est exactement celle qui doit voir ce que l'application garde.
 *
 * Aucun nom n'apparaît, et ce n'est pas l'interface qui le garantit : l'API ne
 * rend aucune identité. L'écran ajoute seulement le seuil d'anonymat, qui
 * remplace un compteur trop petit par « moins de 5 » — un « 1 » désignerait
 * quelqu'un dans une équipe de dix.
 */
@Component({
  selector: 'ws-usage-dashboard',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-5xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Usage</h1>
          <p class="mt-1 text-sm text-content-subtle">
            Combien de comptes se servent de l'outil, et jusqu'où ils vont.
          </p>
        </div>

        <fieldset class="flex items-center gap-1 rounded-lg bg-panel p-1 ring-1 ring-line">
          <legend class="sr-only">Période d'observation</legend>
          @for (choix of periodes; track choix) {
            <!-- Le bouton radio est masqué à l'œil mais reste focusable : sans
                 la règle has-[:focus-visible] posée sur le libellé, l'anneau de
                 focus se dessinerait sur un élément invisible, et la navigation
                 au clavier n'aurait plus aucun repère. -->
            <label
              class="cursor-pointer rounded-md px-3 py-1.5 text-sm text-content-muted
                     has-[:checked]:bg-sunken has-[:checked]:text-content
                     has-[:focus-visible]:outline has-[:focus-visible]:outline-2
                     has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-text"
            >
              <input
                type="radio"
                name="periode"
                class="sr-only"
                [value]="choix"
                [checked]="periode() === choix"
                (change)="changerPeriode(choix)"
              />
              {{ nomPeriode(choix) }}
            </label>
          }
        </fieldset>
      </header>

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
        <div class="mt-3 space-y-3" aria-hidden="true">
          <div class="h-32 animate-pulse rounded-xl bg-sunken"></div>
          <div class="h-48 animate-pulse rounded-xl bg-sunken"></div>
        </div>
      } @else if (apercu(); as vue) {
        @if (vue.comptesActifs === 0) {
          <!-- Le texte diffère de l'annonce vocale juste au-dessus : la
               répéter mot pour mot la ferait entendre deux fois, et
               n'apprendrait rien de plus à qui la lit. -->
          <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
            <p class="text-sm text-content-muted">Rien à mesurer pour l'instant.</p>
            <p class="mt-1 text-sm text-content-subtle">
              Les compteurs se remplissent dès qu'un compte se connecte ou lance une analyse.
              Essayez une fenêtre plus large si l'équipe travaille par à-coups.
            </p>
          </div>
        } @else {
          <!-- ── Tunnel ──────────────────────────────────────────────── -->
          <section class="mt-3" aria-labelledby="titre-tunnel">
            <h2 id="titre-tunnel" class="text-lg font-medium text-content">Tunnel d'usage</h2>
            <p class="mt-1 text-sm text-content-subtle">
              {{ vue.comptesActifs }} compte(s) actif(s) sur {{ nomPeriode(vue.periode) }}.
            </p>

            <ul class="mt-3 space-y-2">
              @for (etape of vue.tunnel; track etape.cle) {
                <li class="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 class="text-sm font-medium text-content">{{ nomEtape(etape.cle) }}</h3>
                    <p class="text-sm text-content-muted">
                      <span class="text-lg font-semibold text-content">
                        {{ montrable(etape.comptes) }}
                      </span>
                      compte(s) · {{ etape.actions }} action(s)
                    </p>
                  </div>

                  <!-- La barre DOUBLE le chiffre, elle ne le remplace pas :
                       une proportion lue seulement à la longueur d'un trait
                       n'est pas lisible pour tout le monde. -->
                  <div
                    class="mt-2 h-2 overflow-hidden rounded-full bg-sunken"
                    role="img"
                    [attr.aria-label]="part(etape, vue.tunnel) + ' % des comptes entrés'"
                  >
                    <div class="h-full bg-brand" [style.width.%]="part(etape, vue.tunnel)"></div>
                  </div>
                  <p class="mt-1 text-xs text-content-subtle">{{ expliquer(etape.cle) }}</p>
                </li>
              }
            </ul>
          </section>

          <!-- ── Courbe ──────────────────────────────────────────────── -->
          <section class="mt-8" aria-labelledby="titre-courbe">
            <h2 id="titre-courbe" class="text-lg font-medium text-content">Activité quotidienne</h2>

            <div class="mt-3 rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line">
              <p class="text-sm text-content-muted">{{ resume() }}</p>

              <!-- Le graphe est une IMAGE : il porte un libellé, et le tableau
                   qui suit porte les mêmes nombres pour qui ne le voit pas. -->
              <div class="mt-3 flex h-32 items-end gap-px" role="img" [attr.aria-label]="resume()">
                @for (barre of barres(); track barre.jour) {
                  <div class="flex h-full flex-1 flex-col justify-end gap-px">
                    <div
                      class="w-full rounded-t-sm bg-brand"
                      [style.height.%]="barre.hauteurAnalyses"
                    ></div>
                    <div
                      class="w-full rounded-t-sm bg-info-content"
                      [style.height.%]="barre.hauteurConnexions"
                    ></div>
                  </div>
                }
              </div>

              <div class="mt-2 flex items-center gap-4 text-xs text-content-subtle">
                <span class="flex items-center gap-1">
                  <span class="size-2 rounded-sm bg-brand" aria-hidden="true"></span>
                  Analyses
                </span>
                <span class="flex items-center gap-1">
                  <span class="size-2 rounded-sm bg-info-content" aria-hidden="true"></span>
                  Connexions
                </span>
              </div>

              <details class="mt-3">
                <summary class="cursor-pointer text-sm text-brand-text hover:underline">
                  Voir les chiffres jour par jour
                </summary>
                <table class="mt-2 w-full text-left text-sm">
                  <caption class="sr-only">
                    Connexions et analyses, jour par jour
                  </caption>
                  <thead>
                    <tr class="text-xs text-content-subtle">
                      <th scope="col" class="py-1">Jour</th>
                      <th scope="col" class="py-1">Connexions</th>
                      <th scope="col" class="py-1">Analyses</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (barre of barres(); track barre.jour) {
                      <tr class="border-t border-line text-content-muted">
                        <th scope="row" class="py-1 font-normal">{{ court(barre.jour) }}</th>
                        <td class="py-1">{{ barre.connexions }}</td>
                        <td class="py-1">{{ barre.analyses }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </details>
            </div>
          </section>

          <!-- ── Gammes ──────────────────────────────────────────────── -->
          @if (vue.gammes.length > 0) {
            <section class="mt-8" aria-labelledby="titre-gammes">
              <h2 id="titre-gammes" class="text-lg font-medium text-content">Par gamme</h2>

              <table class="mt-3 w-full text-left text-sm">
                <caption class="sr-only">
                  Analyses et score moyen par gamme
                </caption>
                <thead>
                  <tr class="text-xs text-content-subtle">
                    <th scope="col" class="py-2">Gamme</th>
                    <th scope="col" class="py-2">Analyses</th>
                    <th scope="col" class="py-2">Score moyen</th>
                  </tr>
                </thead>
                <tbody>
                  @for (gamme of vue.gammes; track gamme.gamme) {
                    <tr class="border-t border-line">
                      <th scope="row" class="py-2 font-normal text-content">{{ gamme.gamme }}</th>
                      <td class="py-2 text-content-muted">{{ gamme.analyses }}</td>
                      <td class="py-2 text-content-muted">
                        @if (gamme.scoreMoyen === null) {
                          <!-- Aucune page notée n'est pas un score de zéro. -->
                          <span class="text-content-subtle">non mesuré</span>
                        } @else {
                          {{ gamme.scoreMoyen | number: '1.0-1' }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        }
      }

      <!-- ── Registre de traitement ────────────────────────────────── -->
      @if (gouvernance(); as registre) {
        <section class="mt-10 border-t border-line pt-8" aria-labelledby="titre-registre">
          <h2 id="titre-registre" class="text-lg font-medium text-content">
            Ce que l'application conserve
          </h2>
          <p class="mt-1 text-sm text-content-subtle">
            Ce registre est produit par le code, à partir des tables réellement lues — il ne peut
            pas se désynchroniser de ce que l'application fait.
          </p>

          <p class="mt-3 rounded-lg bg-ok-surface p-3 text-sm text-ok-content">
            Aucune collecte dédiée : les statistiques ci-dessus sont calculées à partir de données
            déjà enregistrées pour d'autres raisons.
          </p>

          <table class="mt-4 w-full text-left text-sm">
            <caption class="sr-only">
              Tables contenant des données personnelles, finalité et conservation
            </caption>
            <thead>
              <tr class="text-xs text-content-subtle">
                <th scope="col" class="py-2">Table</th>
                <th scope="col" class="py-2">Finalité</th>
                <th scope="col" class="py-2">Données</th>
                <th scope="col" class="py-2">Conservation</th>
              </tr>
            </thead>
            <tbody>
              @for (source of registre.sources; track source.table) {
                <tr class="border-t border-line align-top">
                  <th scope="row" class="py-2 font-normal text-content">
                    <code>{{ source.table }}</code>
                  </th>
                  <td class="py-2 text-content-muted">{{ source.finalite }}</td>
                  <td class="py-2 text-content-muted">{{ source.donnees.join(', ') }}</td>
                  <td class="py-2 text-content-muted">{{ retention(source.retentionJours) }}</td>
                </tr>
              }
            </tbody>
          </table>

          <div class="mt-4 rounded-xl bg-panel p-4 ring-1 ring-line">
            <h3 class="text-sm font-medium text-content">Anonymisation du journal</h3>
            <p class="mt-1 text-sm text-content-muted">
              Passé {{ registre.anonymisation.apresJours }} jours, une entrée perd son identifiant,
              son nom et son adresse IP. L'action, sa cible et sa date restent.
            </p>
            <dl class="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt class="text-xs text-content-subtle">Déjà anonymisées</dt>
                <dd class="font-semibold text-content">{{ registre.anonymisation.anonymisees }}</dd>
              </div>
              <div>
                <dt class="text-xs text-content-subtle">En attente</dt>
                <dd
                  class="font-semibold"
                  [class.text-content]="!enRetard(registre)"
                  [class.text-warn-content]="enRetard(registre)"
                >
                  {{ registre.anonymisation.enAttente }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-content-subtle">Dernier passage</dt>
                <dd class="font-semibold text-content">
                  @if (registre.anonymisation.dernierPassage; as passage) {
                    {{ passage | date: 'dd/MM/yyyy à HH:mm' }}
                  } @else {
                    <!-- Le minuteur tourne au démarrage : « aucun passage »
                         vaut mieux que de laisser croire à une absence de
                         travail. -->
                    <span class="text-content-subtle">aucun depuis le démarrage</span>
                  }
                </dd>
              </div>
            </dl>
          </div>
        </section>
      }
    </main>
  `,
})
export class UsageDashboardComponent {
  private readonly api = inject(UsageApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly periodes = PERIODES;

  readonly periode = toSignal(
    this.route.queryParams.pipe(map(p => periodeDepuisParams(p as Record<string, string>))),
    { initialValue: '30j' as const },
  );

  readonly apercu = signal<UsageOverview | null>(null);
  readonly gouvernance = signal<UsageGovernance | null>(null);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);

  private derniereCle = '';

  readonly barres = computed(() => barresDeLaSerie(this.apercu()?.parJour ?? []));
  readonly resume = computed(() => resumerSerie(this.apercu()?.parJour ?? []));

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement des statistiques…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const vue = this.apercu();
    if (!vue || vue.comptesActifs === 0) return 'Aucune activité sur cette période.';
    return `${vue.comptesActifs} compte(s) actif(s) sur ${libellePeriode(vue.periode)}.`;
  });

  constructor() {
    effect(() => {
      void this.charger(this.periode());
    });
  }

  async charger(periode: UsagePeriod = this.periode()): Promise<void> {
    const cle = periode;
    this.derniereCle = cle;

    this.chargement.set(true);
    this.erreur.set(null);

    try {
      const [apercu, gouvernance] = await Promise.all([
        this.api.overview(periode),
        this.api.governance(),
      ]);
      // Une réponse plus lente qu'un changement de période ne doit pas écraser
      // l'affichage courant.
      if (this.derniereCle !== cle) return;
      this.apercu.set(apercu);
      this.gouvernance.set(gouvernance);
    } catch {
      if (this.derniereCle !== cle) return;
      this.erreur.set('Impossible de charger les statistiques d’usage.');
      this.apercu.set(null);
      this.gouvernance.set(null);
    } finally {
      if (this.derniereCle === cle) this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  changerPeriode(periode: UsagePeriod): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsDepuisPeriode(periode),
    });
  }

  nomPeriode(periode: UsagePeriod): string {
    return libellePeriode(periode);
  }

  nomEtape(cle: UsageOverview['tunnel'][number]['cle']): string {
    return libelleEtape(cle);
  }

  expliquer(cle: UsageOverview['tunnel'][number]['cle']): string {
    return expliquerEtape(cle);
  }

  montrable(comptes: number): string {
    return compteurMontrable(comptes);
  }

  part(
    etape: UsageOverview['tunnel'][number],
    tunnel: readonly UsageOverview['tunnel'][number][],
  ): number {
    return partDuTunnel(etape, tunnel);
  }

  court(jour: string): string {
    return jourCourt(jour);
  }

  retention(jours: number | null): string {
    return libelleRetention(jours);
  }

  enRetard(registre: UsageGovernance): boolean {
    return anonymisationEnRetard(registre.anonymisation.enAttente);
  }
}
