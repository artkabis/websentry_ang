import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { Message } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { MessagesApi } from '../../core/messages/messages.api';
import { UsersApi } from '../../core/users/users.api';
import { MessageComposeComponent } from './message-compose.component';

const ID = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';

const ENVOYE: Message = {
  id: ID,
  subject: 'Bascule v2 jeudi',
  body: 'La bascule est programmée jeudi à 14h.',
  importance: 'normale',
  authorId: 'u-1',
  authorName: 'alice',
  attachments: [],
  sentAt: '2026-01-01T00:00:00.000Z',
  readAt: null,
  archivedAt: null,
};

const COMPTES = {
  users: [
    {
      id: ID_BOB,
      username: 'bob',
      displayName: null,
      email: null,
      rank: 10,
      role: 'tester' as const,
      status: 'active' as const,
      lockedUntil: null,
      totalScansLaunched: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    send?: ReturnType<typeof vi.fn>;
    listUsers?: ReturnType<typeof vi.fn>;
    peutLireComptes?: boolean;
  } = {},
) {
  const send = opts.send ?? vi.fn().mockResolvedValue(ENVOYE);
  const listUsers = opts.listUsers ?? vi.fn().mockResolvedValue(COMPTES);

  return {
    send,
    listUsers,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: MessagesApi, useValue: { send } },
      { provide: UsersApi, useValue: { list: listUsers } },
      {
        provide: AuthService,
        useValue: {
          hasPermission: (code: string) =>
            code === 'messages:write' || ((opts.peutLireComptes ?? false) && code === 'users:read'),
        },
      },
    ],
  };
}

/** Remplit l'objet et le message — le minimum qu'un envoi exige. */
async function remplir(objet = 'Bascule v2 jeudi', corps = 'La bascule est jeudi à 14h.') {
  await userEvent.type(screen.getByRole('textbox', { name: /Objet/ }), objet);
  await userEvent.type(screen.getByRole('textbox', { name: /Message/ }), corps);
}

function espionnerNavigation(): ReturnType<typeof vi.fn> {
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  return navigate;
}

/**
 * Dépose des fichiers sur le champ.
 *
 * `applyAccept: false` est DÉLIBÉRÉ : l'attribut `accept` est une commodité de
 * la boîte de dialogue, que l'utilisateur contourne en choisissant « tous les
 * fichiers » ou en glissant-déposant. Laisser la simulation filtrer à sa place
 * testerait le navigateur, pas le garde-fou du composant.
 */
async function joindre(...fichiers: File[]): Promise<void> {
  const champ = screen.getByLabelText(/Pièces jointes/);
  await userEvent.upload(champ, fichiers, { applyAccept: false });
}

afterEach(() => vi.restoreAllMocks());

describe('MessageComposeComponent', () => {
  describe('audience', () => {
    it('propose « à tous » par défaut', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });

      const tous = screen.getByRole('radio', { name: 'Tous les comptes actifs' });
      expect((tous as HTMLInputElement).checked).toBe(true);
    });

    it('RETIRE l’envoi ciblé à qui ne peut pas lire les comptes', async () => {
      // Proposer un choix qu'on ne peut pas honorer est pire que de ne pas le
      // proposer : l'auteur choisirait une audience sans liste à cocher.
      await render(MessageComposeComponent, { providers: setup().providers });

      expect(screen.queryByRole('radio', { name: 'Des comptes nommés' })).toBeNull();
      expect(screen.getByRole('radio', { name: 'Un rang et au-dessus' })).toBeTruthy();
    });

    it('l’offre à qui détient users:read', async () => {
      await render(MessageComposeComponent, {
        providers: setup({ peutLireComptes: true }).providers,
      });

      expect(screen.getByRole('radio', { name: 'Des comptes nommés' })).toBeTruthy();
    });

    it('n’affiche le rang QUE pour une audience de rang', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });
      expect(screen.queryByRole('combobox', { name: /Rang visé/ })).toBeNull();

      await userEvent.click(screen.getByRole('radio', { name: 'Un rang et au-dessus' }));
      expect(screen.getByRole('combobox', { name: /Rang visé/ })).toBeTruthy();
    });

    it('OUBLIE la cible précédente en changeant d’audience', async () => {
      // La garder ferait partir un rang avec un envoi « à tous », que le
      // schéma refuse — et l'auteur ne comprendrait pas d'où vient le refus.
      const t = setup();
      await render(MessageComposeComponent, { providers: t.providers });
      await remplir();

      await userEvent.click(screen.getByRole('radio', { name: 'Un rang et au-dessus' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Rang visé/ }), '50');
      await userEvent.click(screen.getByRole('radio', { name: 'Tous les comptes actifs' }));
      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect(t.send).toHaveBeenCalledWith(
        expect.objectContaining({ audience: 'tous' }),
        expect.anything(),
      );
      expect(t.send.mock.calls[0]?.[0]).not.toHaveProperty('audienceRank');
    });

    it('charge les comptes ACTIFS seulement', async () => {
      // Proposer un compte suspendu produirait un envoi qui ne touche
      // personne.
      const t = setup({ peutLireComptes: true });
      await render(MessageComposeComponent, { providers: t.providers });
      await tick();

      expect(t.listUsers).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });

    it('PROPOSE une reprise quand la liste des comptes échoue', async () => {
      const listUsers = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(MessageComposeComponent, {
        providers: setup({ peutLireComptes: true, listUsers }).providers,
      });
      await tick();

      await userEvent.click(screen.getByRole('radio', { name: 'Des comptes nommés' }));
      const alerte = await screen.findByRole('alert');
      expect(within(alerte).getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    });

    it('envoie les comptes cochés', async () => {
      const t = setup({ peutLireComptes: true });
      await render(MessageComposeComponent, { providers: t.providers });
      await tick();
      await remplir();

      await userEvent.click(screen.getByRole('radio', { name: 'Des comptes nommés' }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /bob/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect(t.send).toHaveBeenCalledWith(
        expect.objectContaining({ audience: 'comptes', recipientIds: [ID_BOB] }),
        expect.anything(),
      );
    });
  });

  describe('validation avant l’appel réseau', () => {
    it('n’affiche AUCUN reproche sur un formulaire vierge', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });

      expect(screen.queryByRole('status')).toBeNull();
    });

    it('DÉSACTIVE l’envoi tant que le brouillon ne vaut rien', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });

      expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(true);
    });

    it('SIGNALE un objet trop court, en le nommant', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });
      await remplir('ab', 'Un corps de message.');

      const etat = await screen.findByRole('status');
      expect(etat.textContent).toContain('Objet');
    });

    it('EXIGE le rang sur une audience de rang', async () => {
      const t = setup();
      await render(MessageComposeComponent, { providers: t.providers });
      await remplir();
      await userEvent.click(screen.getByRole('radio', { name: 'Un rang et au-dessus' }));

      expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(true);
      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Rang visé/ }), '50');
      expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(false);
    });

    it('compte les caractères restants', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });
      await userEvent.type(screen.getByRole('textbox', { name: /Message/ }), 'abcde');

      expect(screen.getByText(/9995 caractères restants/)).toBeTruthy();
    });
  });

  describe('pièces jointes', () => {
    it('liste ce qui est joint, avec sa taille', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });
      await joindre(new File([new Uint8Array(2048)], 'capture.png', { type: 'image/png' }));

      expect(screen.getByText('capture.png')).toBeTruthy();
      expect(screen.getByText('2 ko')).toBeTruthy();
    });

    it('REFUSE un format hors liste AVANT l’appel réseau', async () => {
      const t = setup();
      await render(MessageComposeComponent, { providers: t.providers });
      await remplir();
      await joindre(new File([new Uint8Array(10)], 'outil.exe'));

      const etat = await screen.findByRole('status');
      expect(etat.textContent).toContain('outil.exe');
      expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(true);
    });

    it('REFUSE une quatrième pièce', async () => {
      await render(MessageComposeComponent, { providers: setup().providers });
      await remplir();
      await joindre(
        new File([new Uint8Array(1)], '1.png', { type: 'image/png' }),
        new File([new Uint8Array(1)], '2.png', { type: 'image/png' }),
        new File([new Uint8Array(1)], '3.png', { type: 'image/png' }),
        new File([new Uint8Array(1)], '4.png', { type: 'image/png' }),
      );

      expect((await screen.findByRole('status')).textContent).toContain('Au plus 3');
    });

    it('DIT que le serveur vérifie le contenu réel', async () => {
      // Le contrôle du client ne lit que le nom et le type annoncé : le
      // laisser croire plus fort qu'il n'est tromperait sur ce qui passera.
      await render(MessageComposeComponent, { providers: setup().providers });

      expect(screen.getByText(/vérifie le contenu réel/)).toBeTruthy();
    });

    it('joint les fichiers à l’envoi', async () => {
      const t = setup();
      await render(MessageComposeComponent, { providers: t.providers });
      await remplir();
      await joindre(new File([new Uint8Array(4)], 'capture.png', { type: 'image/png' }));

      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      const fichiers = t.send.mock.calls[0]?.[1] as File[];
      expect(fichiers).toHaveLength(1);
      expect(fichiers[0]?.name).toBe('capture.png');
    });
  });

  describe('envoi', () => {
    it('mène au message envoyé, DÉPLIÉ', async () => {
      // L'auteur voit ce que ses destinataires liront, plutôt qu'un accusé.
      const t = setup();
      await render(MessageComposeComponent, { providers: t.providers });
      const navigate = espionnerNavigation();
      await remplir();

      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect(navigate).toHaveBeenCalledWith(['/messages'], { queryParams: { ouvert: ID } });
    });

    it('RELAIE le message de l’API quand elle en donne un', async () => {
      const send = vi
        .fn()
        .mockRejectedValue({ error: { message: 'Aucun compte actif ne correspond.' } });
      await render(MessageComposeComponent, { providers: setup({ send }).providers });
      await remplir();

      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect((await screen.findByRole('alert')).textContent).toContain('Aucun compte actif');
    });

    it('relaie le PREMIER message quand l’API en donne une liste', async () => {
      const send = vi.fn().mockRejectedValue({ error: { message: ['subject : trop court'] } });
      await render(MessageComposeComponent, { providers: setup({ send }).providers });
      await remplir();

      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect((await screen.findByRole('alert')).textContent).toContain('trop court');
    });

    it('REPLIE sur un message clair quand l’API n’en donne aucun', async () => {
      const send = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(MessageComposeComponent, { providers: setup({ send }).providers });
      await remplir();

      await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
      await tick();

      expect((await screen.findByRole('alert')).textContent).toContain('n’est pas parti');
    });
  });
});
