import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { of } from 'rxjs';
import type { Message, MessageCounts } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { MessagesApi } from '../../core/messages/messages.api';
import { MessagesInboxComponent } from './messages-inbox.component';

const ID = '11111111-1111-4111-8111-111111111111';

function message(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    subject: 'Bascule v2 jeudi',
    body: 'La bascule est programmée jeudi à 14h.',
    importance: 'haute',
    authorId: 'u-1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T08:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

const COMPTEURS: MessageCounts = { total: 3, nonLus: 2, interrompt: 1 };

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    items?: Message[];
    total?: number;
    list?: ReturnType<typeof vi.fn>;
    counts?: ReturnType<typeof vi.fn>;
    open?: ReturnType<typeof vi.fn>;
    setArchived?: ReturnType<typeof vi.fn>;
    markAllRead?: ReturnType<typeof vi.fn>;
    params?: Record<string, string>;
    peutEcrire?: boolean;
  } = {},
) {
  const list =
    opts.list ??
    vi.fn().mockResolvedValue({
      items: opts.items ?? [message()],
      total: opts.total ?? opts.items?.length ?? 1,
    });
  const counts = opts.counts ?? vi.fn().mockResolvedValue(COMPTEURS);
  const open =
    opts.open ?? vi.fn().mockResolvedValue(message({ readAt: '2026-01-02T00:00:00.000Z' }));
  const setArchived =
    opts.setArchived ??
    vi.fn().mockResolvedValue(message({ archivedAt: '2026-01-02T00:00:00.000Z' }));
  const markAllRead =
    opts.markAllRead ?? vi.fn().mockResolvedValue({ total: 3, nonLus: 0, interrompt: 0 });

  return {
    list,
    counts,
    open,
    setArchived,
    markAllRead,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: MessagesApi,
        useValue: {
          list,
          counts,
          open,
          setArchived,
          markAllRead,
          pieceUrl: (id: string) => `/api/v1/messages/pieces/${id}`,
        },
      },
      {
        provide: AuthService,
        useValue: {
          hasPermission: (code: string) => (opts.peutEcrire ?? false) && code === 'messages:write',
        },
      },
      {
        provide: ActivatedRoute,
        useValue: { queryParams: of(opts.params ?? {}), snapshot: { queryParams: {} } },
      },
    ],
  };
}

function espionnerNavigation(): ReturnType<typeof vi.fn> {
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  return navigate;
}

afterEach(() => vi.restoreAllMocks());

describe('MessagesInboxComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement', async () => {
      const list = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(MessagesInboxComponent, { providers: setup({ list }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche les messages une fois chargés', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();

      expect(await screen.findByRole('heading', { name: /Bascule v2 jeudi/ })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('1 message(s) trouvé(s)');
    });

    it('EXPLIQUE une boîte vide au lieu d’annoncer « aucun résultat »', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ items: [], total: 0 }).providers,
      });
      await tick();

      expect(screen.getByText(/Votre boîte est vide/)).toBeTruthy();
      expect(screen.getByText(/arriveront ici/)).toBeTruthy();
    });

    it('distingue « rien du tout » de « rien qui corresponde »', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ items: [], total: 0, params: { recherche: 'absent' } }).providers,
      });
      await tick();

      expect(screen.getByText(/ne correspond à ces filtres/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Effacer les filtres' })).toBeTruthy();
    });

    it('PROPOSE une reprise quand le chargement échoue', async () => {
      const list = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(MessagesInboxComponent, { providers: setup({ list }).providers });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('Impossible de charger');
      expect(within(alerte).getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    });
  });

  describe('ce que la boîte montre', () => {
    it('SIGNALE un message non lu autrement que par la couleur', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByText('Non lu')).toBeTruthy();
    });

    it('ne signale PAS un message déjà lu', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ items: [message({ readAt: '2026-01-02T00:00:00.000Z' })] }).providers,
      });
      await tick();

      expect(screen.queryByText('Non lu')).toBeNull();
    });

    it('offre les pièces jointes en TÉLÉCHARGEMENT direct', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({
          items: [
            message({
              attachments: [{ id: 'p-1', nom: 'capture.png', mime: 'image/png', taille: 2048 }],
            }),
          ],
        }).providers,
      });
      await tick();

      const lien = await screen.findByRole('link', { name: /capture\.png/ });
      expect(lien.getAttribute('href')).toBe('/api/v1/messages/pieces/p-1');
      expect(lien.getAttribute('download')).toBe('capture.png');
      expect(lien.textContent).toContain('2 ko');
    });

    it('nomme un auteur supprimé plutôt que de laisser un vide', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ items: [message({ authorId: null, authorName: null })] }).providers,
      });
      await tick();

      expect(screen.getByText(/compte supprimé/)).toBeTruthy();
    });

    it('n’offre NI suppression NI réécriture', async () => {
      // L'API n'en expose pas : le proposer donnerait une fausse idée de ce
      // qui est garanti au destinataire.
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Supprimer/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
    });

    it('n’offre « Écrire » qu’à qui détient messages:write', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();
      expect(screen.queryByRole('link', { name: 'Écrire un message' })).toBeNull();
    });

    it('offre « Écrire » à qui le détient', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ peutEcrire: true }).providers,
      });
      await tick();

      expect(screen.getByRole('link', { name: 'Écrire un message' })).toBeTruthy();
    });
  });

  describe('lecture', () => {
    it('OUVRIR vaut lecture, sans geste supplémentaire', async () => {
      const t = setup();
      await render(MessagesInboxComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByText('Lire le message'));
      await tick();

      expect(t.open).toHaveBeenCalledWith(ID);
    });

    it('ne RAPPELLE PAS l’API pour un message déjà lu', async () => {
      // L'écriture est idempotente côté serveur ; l'appel serait sans effet et
      // sans objet.
      const t = setup({ items: [message({ readAt: '2026-01-02T00:00:00.000Z' })] });
      await render(MessagesInboxComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByText('Lire le message'));
      await tick();

      expect(t.open).not.toHaveBeenCalled();
    });

    it('n’INTERROMPT PAS la lecture quand le marquage échoue', async () => {
      // Annoncer « la marque de lecture a échoué » interromprait pour rien
      // quelqu'un qui est en train de lire.
      const open = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(MessagesInboxComponent, { providers: setup({ open }).providers });
      await tick();

      await userEvent.click(screen.getByText('Lire le message'));
      await tick();

      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('marque TOUTE la boîte d’un geste, et recharge', async () => {
      const t = setup();
      await render(MessagesInboxComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: 'Tout marquer comme lu' }));
      await tick();

      expect(t.markAllRead).toHaveBeenCalled();
    });

    it('n’offre PAS « tout marquer » sans aucun non-lu', async () => {
      const counts = vi.fn().mockResolvedValue({ total: 2, nonLus: 0, interrompt: 0 });
      await render(MessagesInboxComponent, { providers: setup({ counts }).providers });
      await tick();

      expect(screen.queryByRole('button', { name: 'Tout marquer comme lu' })).toBeNull();
    });
  });

  describe('archivage', () => {
    it('RETIRE la ligne par anticipation', async () => {
      // Le geste est sûr et réversible : attendre l'aller-retour ferait
      // clignoter la liste à chaque rangement.
      const t = setup();
      await render(MessagesInboxComponent, { providers: t.providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: 'Archiver' }));

      expect(screen.queryByRole('heading', { name: /Bascule v2 jeudi/ })).toBeNull();
      expect(t.setArchived).toHaveBeenCalledWith(ID, true);
    });

    it('REMET la ligne quand le serveur refuse, et le dit', async () => {
      const setArchived = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(MessagesInboxComponent, { providers: setup({ setArchived }).providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: 'Archiver' }));
      await tick();

      expect(screen.getByRole('heading', { name: /Bascule v2 jeudi/ })).toBeTruthy();
      expect((await screen.findByRole('alert')).textContent).toContain('resté dans la boîte');
    });

    it('propose la REMISE EN BOÎTE depuis la vue des archivés', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({
          items: [message({ archivedAt: '2026-01-02T00:00:00.000Z' })],
          params: { archives: 'oui' },
        }).providers,
      });
      await tick();

      expect(screen.getByRole('button', { name: 'Remettre dans la boîte' })).toBeTruthy();
    });
  });

  describe('filtres reflétés dans l’URL', () => {
    it('LIT les filtres de l’URL au chargement', async () => {
      const t = setup({ params: { nonlus: 'oui', importance: 'critique', page: '2' } });
      await render(MessagesInboxComponent, { providers: t.providers });
      await tick();

      expect(t.list).toHaveBeenCalledWith(
        expect.objectContaining({ unread: true, importance: 'critique', offset: 25 }),
      );
    });

    it('ÉCRIT les filtres dans l’URL, donc les rend partageables', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.type(screen.getByRole('searchbox'), 'bascule');
      await userEvent.click(screen.getByRole('button', { name: 'Filtrer' }));

      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: expect.objectContaining({ recherche: 'bascule' }) }),
      );
    });

    it('un compteur FILTRE, et se retire au second clic', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ params: { nonlus: 'oui' } }).providers,
      });
      await tick();
      const navigate = espionnerNavigation();

      const bouton = screen.getByRole('button', { name: /Non lus/ });
      expect(bouton.getAttribute('aria-pressed')).toBe('true');

      await userEvent.click(bouton);
      expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {} }));
    });

    it('n’offre « Réinitialiser » que si un filtre est posé', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();
      expect(screen.queryByRole('button', { name: 'Réinitialiser' })).toBeNull();
    });
  });

  describe('pagination', () => {
    it('ne l’affiche PAS sur une page unique', async () => {
      await render(MessagesInboxComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    });

    it('l’affiche, et borne les deux extrémités', async () => {
      await render(MessagesInboxComponent, {
        providers: setup({ total: 60 }).providers,
      });
      await tick();

      const pagination = screen.getByRole('navigation', { name: 'Pagination' });
      expect(
        within(pagination)
          .getByRole('button', { name: 'Page précédente' })
          .hasAttribute('disabled'),
      ).toBe(true);
      expect(pagination.textContent).toContain('Page 1 sur 3');
    });
  });
});
