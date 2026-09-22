import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../auth/auth.service';

/** Une entrée de navigation, et la condition qui la rend visible. */
interface Entree {
  chemin: string;
  libelle: string;
  visible: () => boolean;
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
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class AppNavComponent {
  private readonly auth = inject(AuthService);

  /** Replié par défaut : sur mobile, la barre ne doit pas manger l'écran. */
  readonly deplie = signal(false);

  private readonly entrees: readonly Entree[] = [
    { chemin: '/tableau-de-bord', libelle: 'Tableau de bord', visible: () => true },
    { chemin: '/analyse', libelle: 'Analyse', visible: () => true },
    { chemin: '/historique', libelle: 'Historique', visible: () => true },
    { chemin: '/profils', libelle: 'Profils', visible: () => true },
    {
      chemin: '/administration/comptes',
      libelle: 'Comptes',
      visible: () => this.auth.hasPermission('users:read'),
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
