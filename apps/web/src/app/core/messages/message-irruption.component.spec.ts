import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { Message } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageIrruptionComponent } from './message-irruption.component';
import { MessageNotificationsService } from './message-notifications.service';

const ID = '11111111-1111-4111-8111-111111111111';

function message(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    subject: 'Coupure de service ce soir',
    body: 'Maintenance à 20h. Aucun audit ne sera perdu.',
    importance: 'critique',
    authorId: 'u-1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T08:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

function setup(impose: Message | null = message()) {
  const irruption = signal<Message | null>(impose);
  const accuserReception = vi.fn().mockImplementation(() => {
    irruption.set(null);
    return Promise.resolve();
  });

  return {
    irruption,
    accuserReception,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: MessageNotificationsService,
        useValue: { irruption, accuserReception },
      },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('MessageIrruptionComponent', () => {
  it('n’affiche RIEN quand aucun message ne s’impose', async () => {
    await render(MessageIrruptionComponent, { providers: setup(null).providers });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('s’impose, et se NOMME par son objet', async () => {
    // Un dialogue sans nom accessible s'annonce « dialogue » et rien d'autre.
    await render(MessageIrruptionComponent, { providers: setup().providers });

    const fenetre = screen.getByRole('dialog');
    expect(fenetre.getAttribute('aria-modal')).toBe('true');
    expect(fenetre.getAttribute('aria-label')).toContain('Coupure de service ce soir');
  });

  it('montre le corps, l’auteur et la date', async () => {
    await render(MessageIrruptionComponent, { providers: setup().providers });

    expect(screen.getByText(/Maintenance à 20h/)).toBeTruthy();
    expect(screen.getByText(/alice/)).toBeTruthy();
  });

  it('PREND le focus à l’ouverture', async () => {
    // Sans ce déplacement, la tabulation continuerait derrière la fenêtre,
    // dans un écran que l'utilisateur ne voit plus.
    await render(MessageIrruptionComponent, { providers: setup().providers });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: "J'ai lu" }));
  });

  it('se referme d’un geste, qui VAUT lecture', async () => {
    const t = setup();
    await render(MessageIrruptionComponent, { providers: t.providers });

    await userEvent.click(screen.getByRole('button', { name: "J'ai lu" }));

    expect(t.accuserReception).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('se referme aussi par ÉCHAP', async () => {
    // Enfermer dans une fenêtre qu'on ne peut pas quitter pousse à recharger
    // la page, ce qui ne marque rien et la fait revenir.
    const t = setup();
    await render(MessageIrruptionComponent, { providers: t.providers });

    await userEvent.keyboard('{Escape}');

    expect(t.accuserReception).toHaveBeenCalled();
  });

  it('mène à la boîte, DÉPLIÉ, et marque au passage', async () => {
    const t = setup();
    await render(MessageIrruptionComponent, { providers: t.providers });
    const navigate = vi.fn().mockResolvedValue(true);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);

    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir dans mes messages' }));

    expect(t.accuserReception).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/messages'], { queryParams: { ouvert: ID } });
  });

  it('ANNONCE les pièces jointes sans les servir ici', async () => {
    // La fenêtre s'impose : y glisser un téléchargement inviterait à cliquer
    // sans avoir lu.
    await render(MessageIrruptionComponent, {
      providers: setup(
        message({
          attachments: [{ id: 'p-1', nom: 'consigne.pdf', mime: 'application/pdf', taille: 2048 }],
        }),
      ).providers,
    });

    expect(screen.getByText(/1 pièce\(s\) jointe\(s\)/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /consigne\.pdf/ })).toBeNull();
  });

  it('nomme un auteur supprimé plutôt que de laisser un vide', async () => {
    await render(MessageIrruptionComponent, {
      providers: setup(message({ authorId: null, authorName: null })).providers,
    });

    expect(screen.getByText(/compte supprimé/)).toBeTruthy();
  });
});
