import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Message } from '@websentry/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageNotificationsService } from './message-notifications.service';
import { MessagesApi } from './messages.api';

const ID = '11111111-1111-4111-8111-111111111111';

function message(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    subject: 'Coupure de service',
    body: 'Maintenance ce soir à 20h.',
    importance: 'critique',
    authorId: 'u-1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T00:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

function setup(
  opts: {
    counts?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
    open?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const counts = opts.counts ?? vi.fn().mockResolvedValue({ total: 3, nonLus: 2, interrompt: 1 });
  const list = opts.list ?? vi.fn().mockResolvedValue({ items: [message()], total: 1 });
  const open = opts.open ?? vi.fn().mockResolvedValue(message({ readAt: '2026-01-02T00:00:00Z' }));

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MessagesApi, useValue: { counts, list, open } },
    ],
  });

  return { counts, list, open, service: TestBed.inject(MessageNotificationsService) };
}

describe('MessageNotificationsService', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('part de compteurs à ZÉRO, jamais indéfinis', () => {
    // La pastille doit pouvoir se peindre avant la première réponse.
    const t = setup();
    expect(t.service.compteurs()).toEqual({ total: 0, nonLus: 0, interrompt: 0 });
    expect(t.service.irruption()).toBeNull();
  });

  it('lit les compteurs, puis le message à imposer', async () => {
    const t = setup();
    await t.service.rafraichir();

    expect(t.service.compteurs().nonLus).toBe(2);
    expect(t.service.irruption()?.id).toBe(ID);
  });

  it('ne demande AUCUN message quand rien ne doit s’imposer', async () => {
    // Une requête par navigation pour une fenêtre qui ne s'ouvrira pas serait
    // du trafic pur.
    const counts = vi.fn().mockResolvedValue({ total: 5, nonLus: 3, interrompt: 0 });
    const t = setup({ counts });

    await t.service.rafraichir();

    expect(t.list).not.toHaveBeenCalled();
    expect(t.service.irruption()).toBeNull();
  });

  it('ne demande QU’UN message à la fois', async () => {
    const t = setup();
    await t.service.rafraichir();

    expect(t.list).toHaveBeenCalledWith(
      expect.objectContaining({ unread: true, importance: 'critique', limit: 1 }),
    );
  });

  it('RESPECTE un plancher de fréquence entre deux lectures', async () => {
    // Sans lui, un aller-retour entre deux écrans déclencherait deux requêtes
    // par seconde pour une pastille qui ne bouge presque jamais.
    const t = setup();
    await t.service.rafraichir();
    await t.service.rafraichir();

    expect(t.counts).toHaveBeenCalledTimes(1);
  });

  it('relit une fois le plancher passé', async () => {
    const t = setup();
    await t.service.rafraichir();

    vi.advanceTimersByTime(20_000);
    await t.service.rafraichir();

    expect(t.counts).toHaveBeenCalledTimes(2);
  });

  it('relit IMMÉDIATEMENT quand on le force', async () => {
    // Après une action de l'utilisateur, la pastille doit refléter ce qu'il
    // vient de faire, pas attendre quinze secondes.
    const t = setup();
    await t.service.rafraichir();
    await t.service.rafraichir(true);

    expect(t.counts).toHaveBeenCalledTimes(2);
  });

  it('PARTAGE une requête déjà en vol', async () => {
    let resoudre: (v: unknown) => void = () => undefined;
    const counts = vi.fn().mockImplementation(
      () =>
        new Promise(r => {
          resoudre = r;
        }),
    );
    const t = setup({ counts });

    const premier = t.service.rafraichir();
    const second = t.service.rafraichir(true);
    resoudre({ total: 1, nonLus: 0, interrompt: 0 });
    await Promise.all([premier, second]);

    expect(counts).toHaveBeenCalledTimes(1);
  });

  it('GARDE la valeur précédente quand la lecture échoue', async () => {
    // Faire surgir une erreur pour une pastille serait disproportionné.
    const counts = vi
      .fn()
      .mockResolvedValueOnce({ total: 4, nonLus: 1, interrompt: 0 })
      .mockRejectedValueOnce(new Error('réseau'));
    const t = setup({ counts });

    await t.service.rafraichir();
    vi.advanceTimersByTime(20_000);
    await t.service.rafraichir();

    expect(t.service.compteurs().total).toBe(4);
  });

  describe('accusé de lecture', () => {
    it('REFERME la fenêtre tout de suite, puis marque', async () => {
      const t = setup();
      await t.service.rafraichir();

      const promesse = t.service.accuserReception();
      expect(t.service.irruption()).toBeNull();

      await promesse;
      expect(t.open).toHaveBeenCalledWith(ID);
    });

    it('ne ROUVRE PAS la fenêtre quand le marquage échoue', async () => {
      // La rouvrir sur-le-champ enfermerait l'utilisateur dans une boucle
      // qu'il ne peut pas quitter.
      const open = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ open });
      await t.service.rafraichir();

      await t.service.accuserReception();

      expect(t.service.irruption()).toBeNull();
    });

    it('ne fait RIEN sans fenêtre ouverte', async () => {
      const t = setup();
      await t.service.accuserReception();

      expect(t.open).not.toHaveBeenCalled();
    });
  });

  it('OUBLIE tout à la déconnexion', async () => {
    // La boîte n'est plus la sienne : garder la pastille montrerait les
    // messages du compte précédent.
    const t = setup();
    await t.service.rafraichir();

    t.service.oublier();

    expect(t.service.compteurs()).toEqual({ total: 0, nonLus: 0, interrompt: 0 });
    expect(t.service.irruption()).toBeNull();
    // Le plancher est remis à zéro : le compte suivant ne doit pas attendre.
    await t.service.rafraichir();
    expect(t.counts).toHaveBeenCalledTimes(2);
  });
});
