import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { MessageNotificationsService } from './message-notifications.service';

/**
 * Fenêtre d'irruption d'un message critique.
 *
 * Un message `critique` s'impose à l'écran : c'est le seul comportement qui
 * distingue ce niveau des deux autres. Il reste NÉANMOINS refermable d'un
 * geste, et ce geste vaut lecture — enfermer l'utilisateur dans une fenêtre
 * qu'il ne peut pas quitter le pousserait à recharger la page, ce qui ne
 * marquerait rien et le lui ferait revoir.
 *
 * L'accessibilité n'est pas décorative ici, puisque la fenêtre prend le focus :
 * `role="dialog"`, `aria-modal`, libellée par son objet, focus déplacé à
 * l'ouverture, Échap équivalent au bouton. Aucune animation — une irruption qui
 * glisse serait exactement le genre de mouvement que `prefers-reduced-motion`
 * demande d'éviter.
 */
@Component({
  selector: 'ws-message-irruption',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notifications.irruption(); as message) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'Message important : ' + message.subject"
        (keydown.escape)="accuser()"
      >
        <article
          class="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-panel p-6 shadow-lg ring-1 ring-line"
        >
          <p class="text-xs font-medium uppercase tracking-wide text-danger-content">
            Message important
          </p>
          <h2 class="mt-1 text-lg font-semibold text-content">{{ message.subject }}</h2>
          <p class="mt-1 text-xs text-content-subtle">
            {{ message.authorName ?? 'compte supprimé' }} ·
            {{ message.sentAt | date: 'dd/MM/yyyy à HH:mm' }}
          </p>

          <p class="mt-4 whitespace-pre-wrap text-sm text-content-muted">{{ message.body }}</p>

          @if (message.attachments.length > 0) {
            <p class="mt-3 text-xs text-content-subtle">
              {{ message.attachments.length }} pièce(s) jointe(s) — à ouvrir depuis la boîte.
            </p>
          }

          <div class="mt-6 flex flex-wrap items-center gap-3">
            <button
              #accuse
              type="button"
              (click)="accuser()"
              class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
            >
              J'ai lu
            </button>
            <button
              type="button"
              (click)="ouvrirDansLaBoite(message.id)"
              class="text-sm text-content-muted hover:underline"
            >
              Ouvrir dans mes messages
            </button>
          </div>
        </article>
      </div>
    }
  `,
})
export class MessageIrruptionComponent {
  readonly notifications = inject(MessageNotificationsService);
  private readonly router = inject(Router);

  private readonly accuse = viewChild<ElementRef<HTMLButtonElement>>('accuse');

  constructor() {
    // Le focus SUIT la fenêtre : sans ce déplacement, la tabulation
    // continuerait derrière elle, dans un écran que l'utilisateur ne voit plus.
    effect(() => {
      if (this.notifications.irruption()) this.accuse()?.nativeElement.focus();
    });
  }

  accuser(): void {
    void this.notifications.accuserReception();
  }

  /** Ouvrir dans la boîte VAUT lecture aussi : on y arrive déplié. */
  ouvrirDansLaBoite(id: string): void {
    void this.notifications.accuserReception();
    void this.router.navigate(['/messages'], { queryParams: { ouvert: id } });
  }
}
