import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import type { DocBlock, DocIndex, DocPage, DocSearchResponse } from '@websentry/shared';

/** Un bloc de titre — la variante du bloc qui porte une ancre. */
type DocTitre = Extract<DocBlock, { type: 'titre' }>;
import { DocsApi } from '../../core/docs/docs.api';
import { DocBlocsComponent } from './doc-contenu.component';

/** En deçà de deux caractères, l'API refuse la requête : on ne l'appelle pas. */
const LONGUEUR_MIN = 2;

/** Le temps qu'on laisse à une frappe de se terminer avant d'interroger l'API. */
const ATTENTE_FRAPPE_MS = 250;

/**
 * Portail de documentation.
 *
 * Un seul composant sert `/aide` et `/aide/:slug` : le sommaire reste affiché
 * en permanence, et ouvrir une page ne le fait pas disparaître. Naviguer d'une
 * page à l'autre ne recharge donc que la colonne de droite — c'est ce qui
 * distingue un portail consultable d'une suite d'écrans.
 *
 * La recherche vit dans l'URL (`?q=`) : un résultat se partage, se met en
 * favori et survit à un rechargement. Elle est filtrée côté client avant
 * l'appel — deux caractères minimum, comme le schéma partagé l'exige — sans
 * jamais se substituer à l'API, qui reste seule autorité.
 */
@Component({
  selector: 'ws-docs-portal',
  standalone: true,
  imports: [RouterLink, DocBlocsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'raccourci($event)' },
  template: `
    <main class="mx-auto max-w-6xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Aide</h1>
          <p class="mt-1 text-sm text-content-subtle">
            Comment l'outil fonctionne, et ce qu'il fait de vos données.
          </p>
        </div>

        <search class="w-full sm:w-80">
          <label for="ws-docs-q" class="sr-only">Rechercher dans l'aide</label>
          <div class="relative">
            <input
              id="ws-docs-q"
              #champ
              type="search"
              name="q"
              autocomplete="off"
              placeholder="Rechercher dans l'aide…"
              aria-keyshortcuts="/"
              [value]="saisie()"
              (input)="saisir($event)"
              class="w-full rounded-lg bg-panel py-2 pl-3 pr-10 text-sm text-content ring-1 ring-line
                     placeholder:text-content-subtle focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-brand-text"
            />
            <!-- Le raccourci est annoncé par aria-keyshortcuts ; le badge le
                 montre à qui lit l'écran plutôt qu'il ne l'écoute. -->
            <kbd
              aria-hidden="true"
              class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded
                     border border-line px-1.5 py-0.5 font-mono text-xs text-content-subtle"
            >
              /
            </kbd>
          </div>
          @if (saisieTropCourte()) {
            <p class="mt-1 text-xs text-content-subtle">
              Encore un caractère et la recherche démarre.
            </p>
          }
        </search>
      </header>

      <div class="mt-8 grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Sommaire de l'aide" class="lg:sticky lg:top-6 lg:self-start">
          @if (erreurSommaire(); as message) {
            <div class="rounded-lg bg-danger-surface p-4" role="alert">
              <p class="text-sm text-danger-content">{{ message }}</p>
              <button
                type="button"
                (click)="rechargerSommaire()"
                class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
              >
                Réessayer
              </button>
            </div>
          } @else if (chargementSommaire()) {
            <div class="space-y-2" aria-hidden="true">
              <div class="h-4 w-24 animate-pulse rounded bg-sunken"></div>
              <div class="h-8 animate-pulse rounded-lg bg-sunken"></div>
              <div class="h-8 animate-pulse rounded-lg bg-sunken"></div>
              <div class="h-8 animate-pulse rounded-lg bg-sunken"></div>
            </div>
          } @else if (sommaire(); as index) {
            @for (section of index.sections; track section.section) {
              <p
                class="mt-4 text-xs font-semibold uppercase tracking-wide text-content-subtle first:mt-0"
              >
                {{ section.section }}
              </p>
              <ul class="mt-1 space-y-0.5">
                @for (entree of section.pages; track entree.slug) {
                  <li>
                    <a
                      [routerLink]="['/aide', entree.slug]"
                      [attr.aria-current]="entree.slug === slug() ? 'page' : null"
                      class="block rounded-lg px-3 py-1.5 text-sm hover:bg-sunken
                             focus-visible:outline focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                      [class]="
                        entree.slug === slug()
                          ? 'bg-sunken font-medium text-content'
                          : 'text-content-muted'
                      "
                    >
                      {{ entree.titre }}
                    </a>
                  </li>
                }
              </ul>
            }
          }
        </nav>

        <div>
          <p role="status" aria-live="polite" class="text-sm text-content-subtle">
            {{ messageEtat() }}
          </p>

          @if (termeActif(); as terme) {
            <!-- ── Résultats de recherche ──────────────────────────────── -->
            @if (erreurRecherche(); as message) {
              <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
                <p class="text-sm text-danger-content">{{ message }}</p>
                <button
                  type="button"
                  (click)="relancerRecherche()"
                  class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
                >
                  Réessayer
                </button>
              </div>
            } @else if (chargementRecherche()) {
              <div class="mt-3 space-y-3" aria-hidden="true">
                <div class="h-20 animate-pulse rounded-xl bg-sunken"></div>
                <div class="h-20 animate-pulse rounded-xl bg-sunken"></div>
              </div>
            } @else if (resultats(); as reponse) {
              @if (reponse.resultats.length === 0) {
                <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
                  <p class="text-sm text-content-muted">Le mot cherché n'apparaît nulle part.</p>
                  <p class="mt-1 text-sm text-content-subtle">
                    Essayez un terme plus court, ou parcourez le sommaire à gauche — il tient en
                    quelques pages.
                  </p>
                </div>
              } @else {
                <ul class="mt-3 space-y-3">
                  @for (hit of reponse.resultats; track hit.slug) {
                    <li>
                      <a
                        [routerLink]="['/aide', hit.slug]"
                        class="block rounded-xl bg-panel p-4 ring-1 ring-line hover:ring-brand
                               focus-visible:outline focus-visible:outline-2
                               focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                      >
                        <p class="text-xs uppercase tracking-wide text-content-subtle">
                          {{ hit.section }}
                        </p>
                        <p class="mt-0.5 text-sm font-medium text-content">{{ hit.titre }}</p>
                        <p class="mt-1 text-sm text-content-muted">{{ hit.extrait }}</p>
                      </a>
                    </li>
                  }
                </ul>
                <p class="mt-3 text-xs text-content-subtle">
                  {{ reponse.resultats.length }} page(s) affichée(s) sur {{ reponse.total }} pour «
                  {{ terme }} ».
                </p>
              }
            }
          } @else if (slug()) {
            <!-- ── Une page ────────────────────────────────────────────── -->
            @if (erreurPage(); as message) {
              <div class="mt-3 rounded-lg bg-danger-surface p-4" role="alert">
                <p class="text-sm text-danger-content">{{ message }}</p>
                @if (pageIntrouvable()) {
                  <a
                    routerLink="/aide"
                    class="mt-2 inline-block rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
                  >
                    Revenir au sommaire
                  </a>
                } @else {
                  <button
                    type="button"
                    (click)="rechargerPage()"
                    class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
                  >
                    Réessayer
                  </button>
                }
              </div>
            } @else if (chargementPage()) {
              <div class="mt-3 space-y-3" aria-hidden="true">
                <div class="h-7 w-2/3 animate-pulse rounded bg-sunken"></div>
                <div class="h-4 animate-pulse rounded bg-sunken"></div>
                <div class="h-4 w-5/6 animate-pulse rounded bg-sunken"></div>
                <div class="h-40 animate-pulse rounded-xl bg-sunken"></div>
              </div>
            } @else if (page(); as vue) {
              <article class="mt-3">
                <!-- Le titre reçoit le focus à chaque changement de page : sans
                     cela, le clavier resterait dans le sommaire et le lecteur
                     d'écran continuerait de lire l'ancienne page. -->
                <h2 #titrePage tabindex="-1" class="text-xl font-semibold text-content">
                  {{ vue.titre }}
                </h2>

                @if (ancresDe(vue).length > 1) {
                  <nav
                    aria-label="Sur cette page"
                    class="mt-3 rounded-lg bg-panel p-3 ring-1 ring-line"
                  >
                    <p class="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                      Sur cette page
                    </p>
                    <ul class="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      @for (ancre of ancresDe(vue); track ancre.ancre) {
                        <li>
                          <!-- routerLink et non un href nu : la balise base du
                               document ferait résoudre « #ancre » depuis la
                               racine, et le lien renverrait au tableau de
                               bord. -->
                          <a
                            [routerLink]="[]"
                            [fragment]="ancre.ancre"
                            queryParamsHandling="preserve"
                            class="rounded text-sm text-brand-text underline underline-offset-2
                                   hover:no-underline focus-visible:outline focus-visible:outline-2
                                   focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                          >
                            {{ ancre.texte }}
                          </a>
                        </li>
                      }
                    </ul>
                  </nav>
                }

                <ws-doc-blocs [blocs]="vue.blocs" />
              </article>
            }
          } @else {
            <!-- ── Accueil du portail ──────────────────────────────────── -->
            @if (sommaire(); as index) {
              <div class="mt-3 space-y-6">
                @for (section of index.sections; track section.section) {
                  <section>
                    <h2 class="text-sm font-semibold uppercase tracking-wide text-content-subtle">
                      {{ section.section }}
                    </h2>
                    <ul class="mt-2 grid gap-3 sm:grid-cols-2">
                      @for (entree of section.pages; track entree.slug) {
                        <li>
                          <a
                            [routerLink]="['/aide', entree.slug]"
                            class="block h-full rounded-xl bg-panel p-4 ring-1 ring-line hover:ring-brand
                                   focus-visible:outline focus-visible:outline-2
                                   focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                          >
                            <p class="text-sm font-medium text-content">{{ entree.titre }}</p>
                            <p class="mt-1 text-sm text-content-muted">{{ entree.resume }}</p>
                          </a>
                        </li>
                      }
                    </ul>
                  </section>
                }
              </div>
            }
          }
        </div>
      </div>
    </main>
  `,
})
export class DocsPortalComponent {
  private readonly api = inject(DocsApi);
  private readonly router = inject(Router);

  /**
   * Liés par `withComponentInputBinding()` : segment de route et paramètre
   * d'URL.
   *
   * `q` est déclaré facultatif parce que le routeur POUSSE `undefined` quand
   * le paramètre disparaît de l'URL — la valeur par défaut d'`input()` ne
   * couvre que le tout premier rendu, jamais les navigations suivantes.
   */
  readonly slug = input<string | undefined>(undefined);
  readonly q = input<string | undefined>(undefined);

  // Le champ est TOUJOURS dans le gabarit : `required` encode cet invariant
  // dans le type, au lieu d'un `if (!champ)` que rien ne peut déclencher.
  private readonly champ = viewChild.required<ElementRef<HTMLInputElement>>('champ');
  private readonly titrePage = viewChild<ElementRef<HTMLElement>>('titrePage');

  readonly sommaire = signal<DocIndex | null>(null);
  readonly page = signal<DocPage | null>(null);
  readonly resultats = signal<DocSearchResponse | null>(null);

  readonly chargementSommaire = signal(true);
  readonly chargementPage = signal(false);
  readonly chargementRecherche = signal(false);

  readonly erreurSommaire = signal<string | null>(null);
  readonly erreurPage = signal<string | null>(null);
  readonly erreurRecherche = signal<string | null>(null);
  readonly pageIntrouvable = signal(false);

  /** Ce que l'utilisateur a tapé — l'URL ne suit qu'après la pause de frappe. */
  readonly saisie = signal('');

  private minuterie: ReturnType<typeof setTimeout> | null = null;
  private dernierSlug = '';
  private dernierAffiche: string | null = null;
  private dernierTerme = '';

  /** Le terme réellement interrogé : celui de l'URL, pas celui en cours de frappe. */
  readonly termeActif = computed(() => {
    const terme = (this.q() ?? '').trim();
    return terme.length >= LONGUEUR_MIN ? terme : null;
  });

  readonly saisieTropCourte = computed(() => {
    const longueur = this.saisie().trim().length;
    return longueur > 0 && longueur < LONGUEUR_MIN;
  });

  readonly messageEtat = computed(() => {
    const terme = this.termeActif();
    if (terme) {
      if (this.erreurRecherche()) return 'La recherche a échoué.';
      const reponse = this.resultats();
      if (!reponse || this.chargementRecherche()) return `Recherche de « ${terme} »…`;
      return reponse.total === 0
        ? `Aucune page pour « ${terme} ».`
        : `${reponse.total} page(s) pour « ${terme} ».`;
    }
    if (this.slug()) {
      if (this.erreurPage()) return 'Le chargement a échoué.';
      const vue = this.page();
      if (!vue || this.chargementPage()) return 'Chargement de la page…';
      return `${vue.titre} — section ${vue.section}.`;
    }
    if (this.chargementSommaire()) return 'Chargement du sommaire…';
    if (this.erreurSommaire()) return 'Le sommaire n’a pas pu être chargé.';
    return 'Choisissez une page dans le sommaire, ou cherchez un mot.';
  });

  constructor() {
    void this.chargerSommaire();

    effect(() => {
      // L'URL fait foi : une saisie en cours ne doit pas empêcher un retour
      // arrière du navigateur de remettre le champ dans l'état affiché.
      this.saisie.set(this.q() ?? '');
    });

    effect(() => {
      void this.chargerPage(this.slug());
    });

    effect(() => {
      void this.lancerRecherche(this.termeActif());
    });

    effect(() => {
      const vue = this.page();
      const titre = this.titrePage();
      if (!vue || !titre) return;

      const premierRendu = this.dernierAffiche === null;
      const aChange = this.dernierAffiche !== vue.slug;
      this.dernierAffiche = vue.slug;

      // Le focus suit une navigation DANS le portail : sans cela, le clavier
      // resterait dans le sommaire et le lecteur d'écran continuerait de lire
      // l'ancienne page. Au tout premier rendu, en revanche, le focus
      // appartient à qui vient d'arriver — le déplacer serait un vol.
      if (!premierRendu && aChange) titre.nativeElement.focus();
    });
  }

  async chargerSommaire(): Promise<void> {
    this.chargementSommaire.set(true);
    this.erreurSommaire.set(null);
    try {
      this.sommaire.set(await this.api.index());
    } catch {
      this.erreurSommaire.set('Impossible de charger le sommaire de l’aide.');
      this.sommaire.set(null);
    } finally {
      this.chargementSommaire.set(false);
    }
  }

  rechargerSommaire(): void {
    void this.chargerSommaire();
  }

  async chargerPage(slug: string | undefined): Promise<void> {
    if (!slug) {
      this.dernierSlug = '';
      this.page.set(null);
      this.erreurPage.set(null);
      this.pageIntrouvable.set(false);
      return;
    }

    this.dernierSlug = slug;
    this.chargementPage.set(true);
    this.erreurPage.set(null);
    this.pageIntrouvable.set(false);

    try {
      const page = await this.api.page(slug);
      // Une réponse plus lente qu'un changement de page ne doit pas écraser
      // l'affichage courant.
      if (this.dernierSlug !== slug) return;
      this.page.set(page);
    } catch (erreur) {
      if (this.dernierSlug !== slug) return;
      this.page.set(null);
      const introuvable = erreur instanceof HttpErrorResponse && erreur.status === 404;
      this.pageIntrouvable.set(introuvable);
      this.erreurPage.set(
        introuvable
          ? 'Cette page d’aide n’existe pas (ou plus).'
          : 'Impossible de charger cette page d’aide.',
      );
    } finally {
      if (this.dernierSlug === slug) this.chargementPage.set(false);
    }
  }

  /**
   * Titres de niveau 2 d'une page — le sommaire interne.
   *
   * Prend la page plutôt que de relire le signal : le gabarit ne l'appelle que
   * là où la page existe, et un repli sur tableau vide serait une branche
   * inatteignable.
   */
  ancresDe(page: DocPage): readonly DocTitre[] {
    return page.blocs.filter(
      (bloc): bloc is DocTitre => bloc.type === 'titre' && bloc.niveau === 2,
    );
  }

  rechargerPage(): void {
    void this.chargerPage(this.slug());
  }

  async lancerRecherche(terme: string | null): Promise<void> {
    if (terme === null) {
      this.dernierTerme = '';
      this.resultats.set(null);
      this.erreurRecherche.set(null);
      this.chargementRecherche.set(false);
      return;
    }

    this.dernierTerme = terme;
    this.chargementRecherche.set(true);
    this.erreurRecherche.set(null);

    try {
      const reponse = await this.api.rechercher(terme);
      if (this.dernierTerme !== terme) return;
      this.resultats.set(reponse);
    } catch {
      if (this.dernierTerme !== terme) return;
      this.resultats.set(null);
      this.erreurRecherche.set('La recherche n’a pas abouti.');
    } finally {
      if (this.dernierTerme === terme) this.chargementRecherche.set(false);
    }
  }

  relancerRecherche(): void {
    void this.lancerRecherche(this.termeActif());
  }

  /**
   * `/` met le curseur dans la recherche — le geste quotidien d'une équipe qui
   * consulte l'aide entre deux audits.
   */
  raccourci(evenement: KeyboardEvent): void {
    if (evenement.key !== '/' || evenement.defaultPrevented) return;

    // Une barre oblique tapée dans un champ appartient au champ : la lui voler
    // rendrait toute saisie d'URL ou de chemin impossible.
    const cible = evenement.target;
    if (
      cible instanceof HTMLElement &&
      (cible.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(cible.tagName))
    ) {
      return;
    }

    evenement.preventDefault();
    this.champ().nativeElement.focus();
  }

  saisir(evenement: Event): void {
    const valeur = (evenement.target as HTMLInputElement).value;
    this.saisie.set(valeur);

    // On attend la fin de la frappe avant de toucher à l'URL : écrire dans
    // l'historique à chaque caractère rendrait le bouton « précédent »
    // inutilisable.
    if (this.minuterie !== null) clearTimeout(this.minuterie);
    this.minuterie = setTimeout(() => {
      this.minuterie = null;
      const terme = valeur.trim();
      void this.router.navigate([], {
        queryParams: { q: terme.length >= LONGUEUR_MIN ? terme : null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }, ATTENTE_FRAPPE_MS);
  }
}
