import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { MessageNotificationsService } from '../messages/message-notifications.service';

/** Une entrée de navigation, et la condition qui la rend visible. */
interface Entree {
  chemin: string;
  libelle: string;
  visible: () => boolean;
  /** Nombre à mettre en avant sur l'entrée, quand il y a lieu. */
  pastille?: () => number;
}

/**
 * Navigation principale.
 *
 * Elle existe parce que l'application comptait seize routes pour un seul point
 * d'entrée : passer de l'analyse à l'administration demandait de revenir au
 * tableau de bord, et trois écrans — le journal d'audit, la liste et l'éditeur
 * de profils — n'offraient aucune sortie hors du logo.
 *
 * Les entrées sont des FAMILLES, pas des écrans : « Analyse » mène à la page
 * unitaire, d'où le lot et le sitemap sont atteignables. Lister les seize
 * routes rendrait la barre illisible et ferait payer dix tabulations de plus
 * sur chaque écran.
 *
 * L'état actif est annoncé par `aria-current`, pas seulement par la couleur :
 * un fond coloré invisible au lecteur d'écran ne dit pas où l'on est.
 */
@Component({
  selector: 'ws-app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Navigation principale">
      <!-- Sous la largeur d'un téléphone, la barre se replie derrière un
           bouton : six liens côte à côte y deviendraient illisibles. -->
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken sm:hidden"
        [attr.aria-expanded]="deplie()"
        aria-controls="ws-nav-liste"
        (click)="basculer()"
      >
        Menu
      </button>

      <ul id="ws-nav-liste" class="gap-1 sm:flex sm:items-center" [class.hidden]="!deplie()">
        @for (entree of visibles(); track entree.chemin) {
          <li>
            <a
              [routerLink]="entree.chemin"
              routerLinkActive="bg-sunken text-content"
              #actif="routerLinkActive"
              [attr.aria-current]="actif.isActive ? 'page' : null"
              (click)="replier()"
              class="block rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-sunken hover:text-content"
            >
              {{ entree.libelle }}
              @if (entree.pastille?.(); as nombre) {
                <!-- Le nombre seul serait muet au lecteur d'écran : « 3 »
                     accolé à « Messages » ne dit pas trois quoi. -->
                <span
                  class="ml-1 inline-block rounded-full bg-brand px-1.5 text-xs text-on-accent"
                  [attr.aria-label]="nombre + ' message(s) non lu(s)'"
                >
                  {{ nombre }}
                </span>
              }
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class AppNavComponent {
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(MessageNotificationsService);

  /** Replié par défaut : sur mobile, la barre ne doit pas manger l'écran. */
  readonly deplie = signal(false);

  private readonly entrees: readonly Entree[] = [
    { chemin: '/tableau-de-bord', libelle: 'Tableau de bord', visible: () => true },
    { chemin: '/analyse', libelle: 'Analyse', visible: () => true },
    { chemin: '/historique', libelle: 'Historique', visible: () => true },
    { chemin: '/profils', libelle: 'Profils', visible: () => true },
    // Ouvert à tous : signaler ne doit demander aucune permission.
    { chemin: '/retours', libelle: 'Retours', visible: () => true },
    // Ouvert à tous aussi : on écrit AUX comptes, pas seulement aux
    // administrateurs. Composer, lui, demande `messages:write`.
    {
      chemin: '/messages',
      libelle: 'Messages',
      visible: () => true,
      pastille: () => this.notifications.compteurs().nonLus,
    },
    // L'aide demande `docs:read` : afficher le lien à qui recevrait un
    // « accès refusé » serait pire que de ne rien afficher.
    {
      chemin: '/aide',
      libelle: 'Aide',
      visible: () => this.auth.hasPermission('docs:read'),
    },
    {
      chemin: '/administration/comptes',
      libelle: 'Comptes',
      visible: () => this.auth.hasPermission('users:read'),
    },
    {
      chemin: '/administration/usage',
      libelle: 'Usage',
      visible: () => this.auth.hasPermission('usage:read'),
    },
    {
      chemin: '/administration/supervision',
      libelle: 'Supervision',
      visible: () => this.auth.hasPermission('health:read'),
    },
    {
      chemin: '/administration/journal',
      libelle: 'Journal',
      visible: () => this.auth.isSuperAdmin(),
    },
  ];

  /**
   * Ce que l'utilisateur peut réellement ouvrir.
   *
   * Afficher un lien qui mène à « accès refusé » serait pire que de ne rien
   * afficher : l'utilisateur essaie, échoue, et ne sait pas pourquoi.
   */
  readonly visibles = computed(() => this.entrees.filter(e => e.visible()));

  basculer(): void {
    this.deplie.update(ouvert => !ouvert);
  }

  /** Une navigation referme le menu : le laisser ouvert masquerait l'écran visé. */
  replier(): void {
    this.deplie.set(false);
  }
}
