import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { RANKS, type UserSummary } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { MessagesApi } from '../../core/messages/messages.api';
import { UsersApi } from '../../core/users/users.api';
import {
  ACCEPT_PIECES,
  BROUILLON_MESSAGE_VIDE,
  formaterTaille,
  IMPORTANCES,
  libelleAudience,
  libelleImportance,
  messageValide,
  problemesMessage,
  problemesPieces,
  type BrouillonMessage,
} from './message-format';

const AUDIENCES = ['tous', 'rang', 'comptes'] as const;

/** Rangs proposés comme seuil d'envoi, du plus large au plus étroit. */
const RANGS_CIBLES = [
  { valeur: RANKS.TESTER, libelle: 'Testeurs et au-dessus' },
  { valeur: RANKS.EDITOR, libelle: 'Éditeurs et au-dessus' },
  { valeur: RANKS.ADMIN, libelle: 'Administrateurs et au-dessus' },
  { valeur: RANKS.SUPER_ADMIN, libelle: 'Super-administrateurs seulement' },
] as const;

/**
 * Composition d'un message.
 *
 * L'audience est le choix structurant, et l'écran l'annonce avant le reste :
 * écrire à tout le monde et écrire à une personne ne s'écrivent pas pareil.
 * Chaque audience n'affiche QUE sa propre cible, comme le schéma partagé qui
 * est une union discriminée — un rang joint à un envoi « à tous » serait
 * refusé, et à juste titre.
 *
 * L'envoi ciblé par compte exige `users:read` : sans lui, l'auteur n'a aucun
 * moyen de savoir à qui il écrit. L'option est alors RETIRÉE plutôt qu'offerte
 * et vide — proposer un choix qu'on ne peut pas honorer est pire que de ne pas
 * le proposer.
 */
@Component({
  selector: 'ws-message-compose',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-2xl px-4 py-10">
      <nav class="text-sm" aria-label="Fil d'Ariane">
        <a routerLink="/messages" class="text-brand-text hover:underline">Messages</a>
        <span class="mx-2 text-content-subtle" aria-hidden="true">/</span>
        <span class="text-content-muted">Nouveau message</span>
      </nav>

      <h1 class="mt-2 text-2xl font-semibold text-content">Écrire un message</h1>
      <p class="mt-1 text-sm text-content-subtle">
        Une consigne, une annonce. Le destinataire ne peut pas répondre ici — il passera par les
        retours.
      </p>

      @if (erreur(); as message) {
        <div class="mt-4 rounded-lg bg-danger-surface p-4" role="alert">
          <p class="text-sm text-danger-content">{{ message }}</p>
        </div>
      }

      <form class="mt-6 rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line" (ngSubmit)="envoyer()">
        <fieldset>
          <legend class="text-xs font-medium text-content-muted">Destinataires</legend>
          <div class="mt-2 space-y-2">
            @for (audience of audiences(); track audience) {
              <label class="flex items-start gap-2 text-sm text-content">
                <input
                  type="radio"
                  name="audience"
                  [value]="audience"
                  [ngModel]="brouillon().audience"
                  (ngModelChange)="changerAudience($event)"
                  class="mt-0.5 size-4 border-field"
                />
                {{ nomAudience(audience) }}
              </label>
            }
          </div>
        </fieldset>

        @if (brouillon().audience === 'rang') {
          <label class="mt-4 block">
            <span class="text-xs font-medium text-content-muted">Rang visé</span>
            <select
              name="audienceRank"
              [ngModel]="brouillon().audienceRank"
              (ngModelChange)="maj({ audienceRank: $event })"
              class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
            >
              <option value="">Choisir un rang</option>
              @for (rang of rangs; track rang.valeur) {
                <option [value]="rang.valeur">{{ rang.libelle }}</option>
              }
            </select>
          </label>
        }

        @if (brouillon().audience === 'comptes') {
          <fieldset class="mt-4">
            <legend class="text-xs font-medium text-content-muted">Comptes visés</legend>
            @if (chargementComptes()) {
              <p class="mt-2 text-sm text-content-subtle" role="status">Chargement des comptes…</p>
            } @else if (erreurComptes()) {
              <div class="mt-2 rounded-lg bg-danger-surface p-3" role="alert">
                <p class="text-sm text-danger-content">La liste des comptes n'a pas pu être lue.</p>
                <button
                  type="button"
                  (click)="chargerComptes()"
                  class="mt-2 rounded-lg bg-danger-solid px-3 py-1.5 text-sm font-medium text-on-accent"
                >
                  Réessayer
                </button>
              </div>
            } @else if (comptes().length === 0) {
              <p class="mt-2 text-sm text-content-subtle">Aucun autre compte actif.</p>
            } @else {
              <ul
                class="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-field p-2"
              >
                @for (compte of comptes(); track compte.id) {
                  <li>
                    <label class="flex items-center gap-2 text-sm text-content">
                      <input
                        type="checkbox"
                        [attr.name]="'compte-' + compte.id"
                        [checked]="estChoisi(compte.id)"
                        (change)="basculerCompte(compte.id)"
                        class="size-4 rounded border-field"
                      />
                      {{ compte.username }}
                      <span class="text-xs text-content-subtle">{{ compte.role }}</span>
                    </label>
                  </li>
                }
              </ul>
              <p class="mt-1 text-xs text-content-subtle">
                {{ brouillon().recipientIds.length }} compte(s) choisi(s).
              </p>
            }
          </fieldset>
        }

        <label class="mt-4 block">
          <span class="text-xs font-medium text-content-muted">Importance</span>
          <select
            name="importance"
            [ngModel]="brouillon().importance"
            (ngModelChange)="maj({ importance: $event })"
            class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
          >
            @for (importance of importances; track importance) {
              <option [value]="importance">{{ nomImportance(importance) }}</option>
            }
          </select>
          <span class="mt-1 block text-xs text-content-subtle">
            « Critique » s'impose à l'écran du destinataire jusqu'à ce qu'il l'ait lu.
          </span>
        </label>

        <label class="mt-4 block">
          <span class="text-xs font-medium text-content-muted">Objet</span>
          <input
            type="text"
            name="subject"
            required
            [ngModel]="brouillon().subject"
            (ngModelChange)="maj({ subject: $event })"
            placeholder="En une phrase, de quoi il s'agit"
            class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
          />
        </label>

        <label class="mt-4 block">
          <span class="text-xs font-medium text-content-muted">Message</span>
          <textarea
            name="body"
            rows="7"
            required
            [ngModel]="brouillon().body"
            (ngModelChange)="maj({ body: $event })"
            class="mt-1 w-full rounded-lg border border-field bg-panel px-3 py-2 text-sm text-content"
          ></textarea>
          <span class="mt-1 block text-xs text-content-subtle">
            {{ restant() }} caractères restants.
          </span>
        </label>

        <div class="mt-4">
          <label class="block">
            <span class="text-xs font-medium text-content-muted">
              Pièces jointes (facultatif)
            </span>
            <input
              type="file"
              name="fichiers"
              multiple
              [accept]="accept"
              (change)="choisirFichiers($event)"
              class="mt-1 block w-full text-sm text-content-muted file:mr-3 file:rounded-lg file:border-0 file:bg-sunken file:px-3 file:py-2 file:text-sm file:text-content"
            />
          </label>
          <p class="mt-1 text-xs text-content-subtle">
            PNG, JPEG, WebP ou PDF. 3 fichiers au plus, 5 Mo chacun. Le serveur vérifie le contenu
            réel, pas l'extension.
          </p>

          @if (fichiers().length > 0) {
            <ul class="mt-2 space-y-1">
              @for (fichier of fichiers(); track fichier.name) {
                <li class="flex items-center justify-between gap-2 text-sm text-content-muted">
                  <span class="truncate">{{ fichier.name }}</span>
                  <span class="shrink-0 text-xs text-content-subtle">
                    {{ taille(fichier.size) }}
                  </span>
                </li>
              }
            </ul>
          }
        </div>

        @if (problemes().length > 0) {
          <ul class="mt-4 space-y-1" role="status" aria-live="polite">
            @for (probleme of problemes(); track probleme) {
              <li class="text-sm text-danger-content">{{ probleme }}</li>
            }
          </ul>
        }

        <div class="mt-6 flex items-center gap-3">
          <button
            type="submit"
            [disabled]="!envoyable()"
            class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            @if (envoi()) {
              Envoi…
            } @else {
              Envoyer
            }
          </button>
          <a routerLink="/messages" class="text-sm text-content-muted hover:underline"> Annuler </a>
        </div>
      </form>
    </main>
  `,
})
export class MessageComposeComponent implements OnInit {
  private readonly api = inject(MessagesApi);
  private readonly users = inject(UsersApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly importances = IMPORTANCES;
  readonly rangs = RANGS_CIBLES;
  readonly accept = ACCEPT_PIECES;

  readonly brouillon = signal<BrouillonMessage>(BROUILLON_MESSAGE_VIDE);
  readonly fichiers = signal<File[]>([]);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly comptes = signal<UserSummary[]>([]);
  readonly chargementComptes = signal(false);
  readonly erreurComptes = signal(false);

  /** Sans `users:read`, l'envoi ciblé n'a pas de liste à proposer. */
  readonly peutChoisirDesComptes = computed(() => this.auth.hasPermission('users:read'));

  readonly audiences = computed(() =>
    AUDIENCES.filter(a => a !== 'comptes' || this.peutChoisirDesComptes()),
  );

  readonly restant = computed(() => 10_000 - this.brouillon().body.trim().length);

  readonly problemes = computed(() => {
    const brouillon = this.brouillon();
    // Tant que rien n'est saisi, on n'affiche AUCUN reproche : signaler
    // « objet trop court » sur un champ vierge est une alarme permanente.
    const vierge = brouillon.subject === '' && brouillon.body === '';
    return [...(vierge ? [] : problemesMessage(brouillon)), ...problemesPieces(this.fichiers())];
  });

  readonly envoyable = computed(
    () =>
      !this.envoi() &&
      messageValide(this.brouillon()) !== null &&
      problemesPieces(this.fichiers()).length === 0,
  );

  ngOnInit(): void {
    if (this.peutChoisirDesComptes()) void this.chargerComptes();
  }

  async chargerComptes(): Promise<void> {
    this.chargementComptes.set(true);
    this.erreurComptes.set(false);
    try {
      // Seuls les comptes ACTIFS peuvent recevoir : proposer les autres
      // produirait un envoi qui ne touche personne.
      const reponse = await this.users.list({ status: 'active', limit: 100 });
      this.comptes.set(reponse.users);
    } catch {
      this.erreurComptes.set(true);
      this.comptes.set([]);
    } finally {
      this.chargementComptes.set(false);
    }
  }

  maj(partiel: Partial<BrouillonMessage>): void {
    this.brouillon.update(actuel => ({ ...actuel, ...partiel }));
  }

  /**
   * Changer d'audience OUBLIE la cible précédente.
   *
   * La garder ferait partir un rang avec un envoi « à tous », que le schéma
   * refuse — et l'auteur ne comprendrait pas d'où vient le refus.
   */
  changerAudience(audience: string): void {
    this.maj({ audience, audienceRank: '', recipientIds: [] });
  }

  estChoisi(id: string): boolean {
    return this.brouillon().recipientIds.includes(id);
  }

  basculerCompte(id: string): void {
    const actuels = this.brouillon().recipientIds;
    this.maj({
      recipientIds: actuels.includes(id) ? actuels.filter(x => x !== id) : [...actuels, id],
    });
  }

  choisirFichiers(evenement: Event): void {
    const champ = evenement.target as HTMLInputElement;
    this.fichiers.set(Array.from(champ.files ?? []));
  }

  async envoyer(): Promise<void> {
    const charge = messageValide(this.brouillon());
    if (!charge || this.envoi() || problemesPieces(this.fichiers()).length > 0) return;

    this.envoi.set(true);
    this.erreur.set(null);
    try {
      const envoye = await this.api.send(charge, this.fichiers());
      // On mène au message envoyé plutôt qu'à un simple accusé : l'auteur voit
      // ce que ses destinataires liront.
      await this.router.navigate(['/messages'], { queryParams: { ouvert: envoye.id } });
    } catch (err) {
      this.erreur.set(messageDErreur(err, 'L’envoi a échoué. Le message n’est pas parti.'));
    } finally {
      this.envoi.set(false);
    }
  }

  nomImportance(importance: string): string {
    return libelleImportance(importance);
  }

  nomAudience(audience: string): string {
    return libelleAudience(audience);
  }

  taille(octets: number): string {
    return formaterTaille(octets);
  }
}

/** Message de l'API quand elle en donne un, repli sinon. */
function messageDErreur(err: unknown, repli: string): string {
  const reponse = err as { error?: { message?: unknown } };
  const message = reponse.error?.message;
  if (typeof message === 'string' && message.trim() !== '') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return repli;
}
