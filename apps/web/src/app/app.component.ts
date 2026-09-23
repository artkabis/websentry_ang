import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from './core/auth/auth.service';
import { MessageIrruptionComponent } from './core/messages/message-irruption.component';
import { MessageNotificationsService } from './core/messages/message-notifications.service';
import { AppNavComponent } from './core/navigation/app-nav.component';
import { ThemeToggleComponent } from './core/theme/theme-toggle.component';

/**
 * Composant racine.
 *
 * Il retient l'affichage tant que la session initiale n'est pas résolue : sans
 * ce garde-fou, un utilisateur déjà connecté verrait l'écran de connexion
 * clignoter avant d'être redirigé.
 *
 * La barre supérieure porte la navigation principale, le choix d'apparence et
 * un lien d'évitement. Ce dernier n'est pas un ornement : la navigation ajoute
 * des arrêts de tabulation sur CHAQUE écran, et sans lui, atteindre le contenu
 * au clavier coûterait ces arrêts à chaque page.
 */
@Component({
  selector: 'ws-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    ThemeToggleComponent,
    AppNavComponent,
    MessageIrruptionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.loading()) {
      <div class="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span class="text-sm text-content-subtle">Chargement…</span>
      </div>
    } @else {
      <!-- Visible au seul focus clavier. Le remplissage n'est appliqué QU'AU
           focus : posé en permanence, il écraserait le « padding: 0 » de
           sr-only et laisserait une cible cliquable de 24 px dans le coin,
           que le pointeur atteindrait sans la voir. -->
      <a
        href="#contenu"
        (click)="allerAuContenu($event)"
        class="sr-only rounded-lg bg-brand text-sm font-medium text-on-accent focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:px-4 focus:py-3"
      >
        Aller au contenu
      </a>

      <header class="border-b border-line bg-panel">
        <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          @if (auth.user()) {
            <a
              routerLink="/tableau-de-bord"
              class="text-sm font-semibold text-content hover:text-brand-text"
            >
              WebSentry
            </a>
            <ws-app-nav class="order-last w-full sm:order-none sm:w-auto" />
          } @else {
            <span class="text-sm font-semibold text-content">WebSentry</span>
          }
          <div class="ml-auto flex items-center gap-3">
            @if (auth.user()) {
              <!-- Signaler depuis N'IMPORTE QUEL écran, en emportant celui-ci.
                   C'est tout l'enjeu du module : si signaler coûte plus cher
                   que contourner, personne ne signale. -->
              <a
                routerLink="/retours/nouveau"
                [queryParams]="{ depuis: routeCourante() }"
                class="text-sm text-content-muted hover:text-brand-text hover:underline"
              >
                Signaler
              </a>
            }
            <ws-theme-toggle />
          </div>
        </div>
      </header>

      <div #contenu id="contenu" tabindex="-1" class="outline-none">
        <router-outlet />
      </div>

      <!-- Hors du contenu : la fenêtre s'impose PAR-DESSUS l'écran courant,
           quel qu'il soit, et survit à une navigation. -->
      <ws-message-irruption />
    }
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notifications = inject(MessageNotificationsService);

  /**
   * Route affichée, jointe au retour qu'on dépose.
   *
   * Lue sur les événements du routeur plutôt qu'une fois au démarrage : la
   * coquille ne se reconstruit pas d'une navigation à l'autre, et un lien figé
   * enverrait toujours le premier écran visité.
   */
  readonly routeCourante = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      // Sans la chaîne de requête : les filtres d'un écran n'apprennent rien
      // sur le problème signalé, et peuvent contenir une recherche nominative.
      map(e => e.urlAfterRedirects.split('?')[0] ?? ''),
    ),
    { initialValue: '' },
  );

  private readonly contenu = viewChild<ElementRef<HTMLElement>>('contenu');

  constructor() {
    /*
     * Les compteurs se relisent à chaque navigation, jamais en boucle.
     *
     * Un sondage périodique ferait tourner une requête sur un écran qu'on ne
     * regarde plus ; une lecture unique au démarrage laisserait la pastille
     * figée toute la session. La navigation est le moment où l'utilisateur
     * attend déjà quelque chose, et le service pose lui-même un plancher de
     * fréquence.
     */
    effect(() => {
      if (!this.auth.user()) {
        this.notifications.oublier();
        return;
      }
      // Lu pour créer la dépendance : chaque navigation relance l'effet.
      this.routeCourante();
      void this.notifications.rafraichir();
    });
  }

  /**
   * Le saut est traité EN CODE, pas laissé à l'ancre.
   *
   * Avec une base de document à la racine, un fragment nu (`#contenu`) est
   * résolu comme une URL absolue : le routeur quitterait l'écran en cours pour
   * revenir à l'accueil. On déplace donc le focus soi-même.
   */
  allerAuContenu(evenement: Event): void {
    evenement.preventDefault();
    this.contenu()?.nativeElement.focus();
  }
}
