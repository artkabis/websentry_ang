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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import type { Message, MessageCounts } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { MessagesApi } from '../../core/messages/messages.api';
import {
  FILTRES_MESSAGES_VIDES,
  filtresMessagesActifs,
  filtresMessagesDepuisParams,
  filtresMessagesVersRequete,
  formaterTaille,
  IMPORTANCES,
  libelleImportance,
  nombreDePagesMessages,
  paramsDepuisFiltresMessages,
  TAILLE_PAGE_MESSAGES,
  type MessageFilterState,
} from './message-format';

const LIGNES_SQUELETTE = 4;

/**
 * Boîte de réception.
 *
 * Un message s'ouvre EN PLACE : le déplier vaut lecture, et l'API l'enregistre.
 * Demander un geste supplémentaire pour dire « oui, j'ai bien lu » ferait
 * porter au lecteur le travail de tenir l'état à jour.
 *
 * Archiver est RÉVERSIBLE, donc ne se confirme pas : le geste s'annule. La
 * ligne disparaît par anticipation et revient si le serveur refuse — l'écriture
 * est sûre, et attendre l'aller-retour ferait clignoter la liste.
 */
@Component({
  selector: 'ws-messages-inbox',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Messages</h1>
          <p class="mt-1 text-sm text-content-subtle">
            @if (filtres().archived) {
              Ce que vous avez rangé.
            } @else {
              Les consignes et annonces qui vous sont adressées.
            }
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          @if (peutEcrire()) {
            <a
              routerLink="/messages/nouveau"
              class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Écrire un message
            </a>
          }
          @if ((compteurs()?.nonLus ?? 0) > 0) {
            <button
              type="button"
              (click)="toutMarquerLu()"
              [disabled]="enCours() !== null"
              class="rounded-lg border border-field px-3 py-2 text-sm text-content-muted hover:bg-sunken disabled:opacity-50"
            >
              Tout marquer comme lu
            </button>
          }
        </div>
      </header>

      @if (compteurs(); as totaux) {
        <ul class="mt-6 grid grid-cols-3 gap-2">
          <li class="rounded-lg bg-panel p-3 ring-1 ring-line">
            <span class="block text-xs text-content-subtle">Dans la boîte</span>
            <span class="block text-lg font-semibold text-content">{{ totaux.total }}</span>
          </li>
          <li>
            <button
              type="button"
              (click)="basculerNonLus()"
              [attr.aria-pressed]="filtres().unread"
              class="w-full rounded-lg bg-panel p-3 text-left ring-1 ring-line hover:bg-sunken aria-pressed:bg-sunken aria-pressed:ring-brand"
            >
              <span class="block text-xs text-content-subtle">Non lus</span>
              <span class="block text-lg font-semibold text-content">{{ totaux.nonLus }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              (click)="filtrerParImportance('critique')"
              [attr.aria-pressed]="filtres().importance === 'critique'"
              class="w-full rounded-lg bg-panel p-3 text-left ring-1 ring-line hover:bg-sunken aria-pressed:bg-sunken aria-pressed:ring-brand"
            >
              <span class="block text-xs text-content-subtle">À traiter d'abord</span>
              <span class="block text-lg font-semibold text-content">{{ totaux.interrompt }}</span>
            </button>
          </li>
        </ul>
      }

      <form
        class="mt-6 rounded-xl bg-panel p-4 shadow-sm ring-1 ring-line"
        (ngSubmit)="appliquerBrouillon()"
      >
        <fieldset class="grid gap-3 sm:grid-cols-2">
          <legend class="sr-only">Filtres des messages</legend>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Recherche</span>
            <input
              type="search"
              name="recherche"
              [ngModel]="brouillonRecherche()"
              (ngModelChange)="brouillonRecherche.set($event)"
              placeholder="objet ou contenu"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-muted">Importance</span>
            <select
              name="importance"
              [ngModel]="brouillonImportance()"
              (ngModelChange)="brouillonImportance.set($event)"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Toutes</option>
              @for (importance of importances; track importance) {
                <option [value]="importance">{{ nomImportance(importance) }}</option>
              }
            </select>
          </label>
        </fieldset>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            class="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Filtrer
          </button>
          <label class="flex items-center gap-2 text-sm text-content-muted">
            <input
              type="checkbox"
              name="archives"
              [ngModel]="brouillonArchives()"
              (ngModelChange)="brouillonArchives.set($event)"
              class="size-4 rounded border-field"
            />
            Voir les archivés
          </label>
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
      }

      @if (chargement()) {
        <div class="mt-3 space-y-2" aria-hidden="true">
          @for (ligne of squelette; track ligne) {
            <div class="h-24 animate-pulse rounded-xl bg-sunken"></div>
          }
        </div>
      } @else if (messages().length === 0) {
        <div class="mt-3 rounded-xl bg-panel p-8 text-center ring-1 ring-line">
          @if (filtresPoses()) {
            <p class="text-sm text-content-muted">Aucun message ne correspond à ces filtres.</p>
            <button
              type="button"
              (click)="reinitialiser()"
              class="mt-3 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              Effacer les filtres
            </button>
          } @else {
            <p class="text-sm text-content-muted">Votre boîte est vide.</p>
            <p class="mt-1 text-sm text-content-subtle">
              Les consignes et annonces de l'équipe arriveront ici.
            </p>
          }
        </div>
      } @else {
        <ul class="mt-3 space-y-3">
          @for (message of messages(); track message.id) {
            <li
              class="rounded-xl bg-panel p-4 shadow-sm ring-1"
              [class.ring-line]="message.readAt !== null"
              [class.ring-brand]="message.readAt === null"
            >
              <article>
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <h2 class="text-base font-medium text-content">
                    {{ message.subject }}
                    @if (message.readAt === null) {
                      <span class="ml-2 align-middle text-xs font-normal text-brand-text">
                        Non lu
                      </span>
                    }
                  </h2>
                  <span [class]="classeImportance(message.importance)">
                    {{ nomImportance(message.importance) }}
                  </span>
                </div>

                <p class="mt-1 text-xs text-content-subtle">
                  {{ message.authorName ?? 'compte supprimé' }} ·
                  {{ message.sentAt | date: 'dd/MM/yyyy à HH:mm' }}
                  @if (message.attachments.length > 0) {
                    · {{ message.attachments.length }} pièce(s) jointe(s)
                  }
                </p>

                <details class="mt-2" [open]="message.id === ouvert()" (toggle)="ouvrir(message)">
                  <summary class="cursor-pointer text-sm text-brand-text hover:underline">
                    Lire le message
                  </summary>
                  <p class="mt-2 whitespace-pre-wrap text-sm text-content-muted">
                    {{ message.body }}
                  </p>

                  @if (message.attachments.length > 0) {
                    <ul class="mt-3 space-y-1">
                      @for (piece of message.attachments; track piece.id) {
                        <li>
                          <a
                            [href]="lienPiece(piece.id)"
                            [download]="piece.nom"
                            class="inline-flex items-center gap-2 rounded-lg border border-field px-3 py-1.5 text-sm text-content-muted hover:bg-sunken"
                          >
                            {{ piece.nom }}
                            <span class="text-xs text-content-subtle">
                              {{ taille(piece.taille) }}
                            </span>
                          </a>
                        </li>
                      }
                    </ul>
                  }
                </details>

                <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    (click)="basculerArchive(message)"
                    [disabled]="enCours() === message.id"
                    class="rounded-lg border border-field px-3 py-1.5 text-sm text-content-muted hover:bg-sunken disabled:opacity-50"
                  >
                    @if (message.archivedAt === null) {
                      Archiver
                    } @else {
                      Remettre dans la boîte
                    }
                  </button>
                </div>
              </article>
            </li>
          }
        </ul>

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
export class MessagesInboxComponent {
  private readonly api = inject(MessagesApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly squelette = Array.from({ length: LIGNES_SQUELETTE }, (_, i) => i);
  readonly importances = IMPORTANCES;

  readonly filtres = toSignal(
    this.route.queryParams.pipe(map(p => filtresMessagesDepuisParams(p as Record<string, string>))),
    { initialValue: FILTRES_MESSAGES_VIDES },
  );

  /** Message à déplier au chargement — celui qu'une irruption a désigné. */
  readonly ouvert = toSignal(
    this.route.queryParams.pipe(map(p => (p as Record<string, string>)['ouvert'] ?? null)),
    { initialValue: null },
  );

  readonly messages = signal<Message[]>([]);
  readonly total = signal(0);
  readonly compteurs = signal<MessageCounts | null>(null);
  readonly chargement = signal(true);
  readonly erreur = signal<string | null>(null);
  readonly enCours = signal<string | null>(null);

  readonly brouillonRecherche = signal('');
  readonly brouillonImportance = signal('');
  readonly brouillonArchives = signal(false);

  private derniereCle = '';

  readonly peutEcrire = computed(() => this.auth.hasPermission('messages:write'));
  readonly pages = computed(() => nombreDePagesMessages(this.total()));
  readonly filtresPoses = computed(() => filtresMessagesActifs(this.filtres()));

  readonly messageEtat = computed(() => {
    if (this.chargement()) return 'Chargement des messages…';
    if (this.erreur()) return 'Le chargement a échoué.';
    const nombre = this.total();
    if (nombre === 0) return 'Aucun message trouvé.';
    return `${nombre} message(s) trouvé(s).`;
  });

  constructor() {
    effect(() => {
      const filtres = this.filtres();
      this.brouillonRecherche.set(filtres.search);
      this.brouillonImportance.set(filtres.importance);
      this.brouillonArchives.set(filtres.archived);
      void this.charger(filtres);
    });
  }

  async charger(filtres: MessageFilterState = this.filtres()): Promise<void> {
    const cle = JSON.stringify(filtres);
    this.derniereCle = cle;

    this.chargement.set(true);
    this.erreur.set(null);

    try {
      const [liste, compteurs] = await Promise.all([
        this.api.list(filtresMessagesVersRequete(filtres, TAILLE_PAGE_MESSAGES)),
        this.api.counts(),
      ]);
      // Une réponse plus lente qu'une navigation suivante ne doit pas écraser
      // l'affichage courant.
      if (this.derniereCle !== cle) return;
      this.messages.set(liste.items);
      this.total.set(liste.total);
      this.compteurs.set(compteurs);
    } catch {
      if (this.derniereCle !== cle) return;
      this.erreur.set('Impossible de charger les messages.');
      this.messages.set([]);
    } finally {
      if (this.derniereCle === cle) this.chargement.set(false);
    }
  }

  recharger(): void {
    void this.charger();
  }

  /**
   * Ouvrir un message le marque comme lu.
   *
   * L'écriture est idempotente côté API : rouvrir ne repousse pas la date de
   * première lecture. On ne rappelle donc l'API que pour ce qui est encore non
   * lu, et le repli en cas d'échec est de ne rien changer — un message affiché
   * non lu alors qu'il l'est se corrige au rechargement suivant.
   */
  async ouvrir(message: Message): Promise<void> {
    if (message.readAt !== null) return;

    try {
      const majour = await this.api.open(message.id);
      this.messages.update(liste => liste.map(m => (m.id === majour.id ? majour : m)));
      this.compteurs.set(await this.api.counts());
    } catch {
      // Silencieux À DESSEIN : l'utilisateur lit son message, et lui annoncer
      // « la marque de lecture a échoué » l'interromprait pour rien.
    }
  }

  /**
   * Archive ou désarchive, PAR ANTICIPATION.
   *
   * Le geste est sûr et réversible : la ligne quitte la vue tout de suite, et
   * revient si le serveur refuse. Attendre l'aller-retour ferait clignoter la
   * liste à chaque rangement.
   */
  async basculerArchive(message: Message): Promise<void> {
    const versArchive = message.archivedAt === null;
    const avant = this.messages();

    this.enCours.set(message.id);
    this.erreur.set(null);
    // La vue courante ne montre que l'un ou l'autre : le message archivé sort
    // de la boîte, celui qu'on remet sort de la vue des archivés.
    this.messages.update(liste => liste.filter(m => m.id !== message.id));
    this.total.update(n => Math.max(0, n - 1));

    try {
      await this.api.setArchived(message.id, versArchive);
      this.compteurs.set(await this.api.counts());
    } catch {
      this.messages.set(avant);
      this.total.set(avant.length);
      this.erreur.set(
        versArchive
          ? 'L’archivage a échoué. Le message est resté dans la boîte.'
          : 'La remise en boîte a échoué. Le message est resté archivé.',
      );
    } finally {
      this.enCours.set(null);
    }
  }

  async toutMarquerLu(): Promise<void> {
    this.enCours.set('tout');
    this.erreur.set(null);
    try {
      this.compteurs.set(await this.api.markAllRead());
      await this.charger();
    } catch {
      this.erreur.set('Le marquage a échoué. Rien n’a changé.');
    } finally {
      this.enCours.set(null);
    }
  }

  appliquerBrouillon(): void {
    void this.naviguer({
      ...this.filtres(),
      search: this.brouillonRecherche().trim(),
      importance: this.brouillonImportance(),
      archived: this.brouillonArchives(),
      page: 1,
    });
  }

  /** Un compteur agit comme un filtre : recliquer dessus le retire. */
  basculerNonLus(): void {
    void this.naviguer({ ...this.filtres(), unread: !this.filtres().unread, page: 1 });
  }

  filtrerParImportance(importance: string): void {
    const actuel = this.filtres().importance;
    void this.naviguer({
      ...this.filtres(),
      importance: actuel === importance ? '' : importance,
      page: 1,
    });
  }

  reinitialiser(): void {
    void this.naviguer(FILTRES_MESSAGES_VIDES);
  }

  allerALaPage(page: number): void {
    void this.naviguer({ ...this.filtres(), page });
  }

  nomImportance(importance: string): string {
    return libelleImportance(importance);
  }

  taille(octets: number): string {
    return formaterTaille(octets);
  }

  lienPiece(id: string): string {
    return this.api.pieceUrl(id);
  }

  /** Le libellé porte le sens ; la couleur ne fait que l'appuyer. */
  classeImportance(importance: string): string {
    const socle = 'shrink-0 rounded-full px-2 py-0.5 text-xs';
    if (importance === 'critique') return `${socle} bg-danger-surface text-danger-content`;
    if (importance === 'haute') return `${socle} bg-warn-surface text-warn-content`;
    return `${socle} bg-sunken text-content-muted`;
  }

  private naviguer(filtres: MessageFilterState): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: paramsDepuisFiltresMessages(filtres),
    });
  }
}
