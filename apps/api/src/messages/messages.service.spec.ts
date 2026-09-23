import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateMessageInput } from '@websentry/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { MessageRepository } from '../database/repositories/message.repository.js';
import type { AttachmentStorageService } from './attachment-storage.service.js';
import { MessagesService, type MessageActor } from './messages.service.js';

const ALICE: MessageActor = { id: 'u-alice', username: 'alice', ipAddress: '10.0.0.1' };

const LIGNE = {
  id: 'm-1',
  subject: 'Bascule',
  body: 'Jeudi 14h',
  importance: 'haute',
  author_id: 'u-alice',
  author_name: 'alice',
  sent_at: '2026-09-23T10:00:00.000Z',
  read_at: null,
  archived_at: null,
};

const ENVOI: CreateMessageInput = {
  subject: 'Bascule v2',
  body: 'Jeudi 14h.',
  importance: 'normale',
  audience: 'tous',
};

function build(disponible = true) {
  const repo = {
    available: disponible,
    list: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    counts: vi.fn().mockResolvedValue({ total: 0, nonLus: 0, interrompt: 0 }),
    findForRecipient: vi.fn().mockResolvedValue(LIGNE),
    attachmentsOf: vi.fn().mockResolvedValue([]),
    findAttachment: vi.fn().mockResolvedValue(null),
    peutVoir: vi.fn().mockResolvedValue(true),
    recipientsByRank: vi.fn().mockResolvedValue(['u-bob']),
    allRecipients: vi.fn().mockResolvedValue(['u-alice', 'u-bob']),
    existingRecipients: vi.fn().mockResolvedValue(['u-bob']),
    createWithRecipients: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(1),
    setArchived: vi.fn().mockResolvedValue(1),
    markAllRead: vi.fn().mockResolvedValue(3),
  };
  const stockage = {
    ranger: vi.fn().mockResolvedValue([]),
    lire: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50])),
    supprimer: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new MessagesService(
      repo as unknown as MessageRepository,
      stockage as unknown as AttachmentStorageService,
      audit as unknown as AuditService,
    ),
    repo,
    stockage,
    audit,
  };
}

describe('MessagesService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('sans base de données', () => {
    it.each([
      ['list', (s: MessagesService) => s.list({ limit: 25, offset: 0 }, ALICE)],
      ['counts', (s: MessagesService) => s.counts(ALICE)],
      ['get', (s: MessagesService) => s.get('m-1', ALICE)],
      ['open', (s: MessagesService) => s.open('m-1', ALICE)],
      ['setArchived', (s: MessagesService) => s.setArchived('m-1', true, ALICE)],
      ['markAllRead', (s: MessagesService) => s.markAllRead(ALICE)],
      ['send', (s: MessagesService) => s.send(ENVOI, [], ALICE)],
      ['piece', (s: MessagesService) => s.piece('p-1', ALICE)],
    ])('REFUSE %s plutôt que de rendre une boîte vide', async (_nom, appel) => {
      // Une boîte vide et une base absente ne se confondent pas : la première
      // se lit « aucun message », la seconde « je ne sais pas ».
      await expect(appel(build(false).service)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('lecture de la boîte', () => {
    it('relaie les filtres ET le destinataire au dépôt', async () => {
      await t.service.list({ limit: 10, offset: 5, unread: true, search: 'bascule' }, ALICE);

      expect(t.repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-alice', unread: true, search: 'bascule' }),
        10,
        5,
      );
    });

    it('ramène les pièces jointes de toute la page en UNE requête', async () => {
      t.repo.list.mockResolvedValueOnce([LIGNE, { ...LIGNE, id: 'm-2' }]);
      t.repo.attachmentsOf.mockResolvedValueOnce([
        { id: 'p-1', message_id: 'm-1', nom: 'a.png', mime: 'image/png', taille: 10 },
        { id: 'p-2', message_id: 'm-2', nom: 'b.pdf', mime: 'application/pdf', taille: 20 },
      ]);

      const vue = await t.service.list({ limit: 25, offset: 0 }, ALICE);

      expect(t.repo.attachmentsOf).toHaveBeenCalledTimes(1);
      expect(t.repo.attachmentsOf).toHaveBeenCalledWith(['m-1', 'm-2']);
      expect(vue.items[0]?.attachments).toHaveLength(1);
      expect(vue.items[1]?.attachments[0]?.id).toBe('p-2');
    });

    it('rend une liste de pièces VIDE, jamais indéfinie', async () => {
      t.repo.list.mockResolvedValueOnce([LIGNE]);
      const vue = await t.service.list({ limit: 25, offset: 0 }, ALICE);

      expect(vue.items[0]?.attachments).toEqual([]);
    });

    it('rassemble plusieurs pièces sous leur message', async () => {
      t.repo.list.mockResolvedValueOnce([LIGNE]);
      t.repo.attachmentsOf.mockResolvedValueOnce([
        { id: 'p-1', message_id: 'm-1', nom: 'a.png', mime: 'image/png', taille: 10 },
        { id: 'p-2', message_id: 'm-1', nom: 'b.png', mime: 'image/png', taille: 20 },
      ]);

      const vue = await t.service.list({ limit: 25, offset: 0 }, ALICE);
      expect(vue.items[0]?.attachments.map(p => p.id)).toEqual(['p-1', 'p-2']);
    });

    it('horodate en ISO, lecture et archivage compris', async () => {
      t.repo.list.mockResolvedValueOnce([
        { ...LIGNE, read_at: '2026-09-23T11:00:00.000Z', archived_at: '2026-09-24T09:00:00.000Z' },
      ]);

      const vue = await t.service.list({ limit: 25, offset: 0 }, ALICE);
      expect(vue.items[0]?.readAt).toBe('2026-09-23T11:00:00.000Z');
      expect(vue.items[0]?.archivedAt).toBe('2026-09-24T09:00:00.000Z');
    });
  });

  describe('compteurs', () => {
    it('convertit en NOMBRES ce que SUM() rend', async () => {
      // `SUM()` sur une boîte vide rend NULL : sans conversion, la pastille
      // afficherait « null » au premier jour d'un compte neuf.
      t.repo.counts.mockResolvedValueOnce({ total: 5, nonLus: null, interrompt: null });

      await expect(t.service.counts(ALICE)).resolves.toEqual({
        total: 5,
        nonLus: 0,
        interrompt: 0,
      });
    });

    it('rend des ZÉROS quand le dépôt ne ramène aucune ligne', async () => {
      t.repo.counts.mockResolvedValueOnce(null);
      await expect(t.service.counts(ALICE)).resolves.toEqual({
        total: 0,
        nonLus: 0,
        interrompt: 0,
      });
    });
  });

  describe('accès unitaire', () => {
    it('rend 404 sur un message hors de la boîte', async () => {
      // Le même 404 qu'un message inexistant : un 403 confirmerait qu'un
      // message existe sous cet identifiant.
      t.repo.findForRecipient.mockResolvedValueOnce(null);
      await expect(t.service.get('m-1', ALICE)).rejects.toThrow(NotFoundException);
    });

    it('marque lu à l’ouverture, sans exiger un geste de plus', async () => {
      await t.service.open('m-1', ALICE);
      expect(t.repo.markRead).toHaveBeenCalledWith('m-1', 'u-alice');
    });

    it('n’ouvre PAS ce qui n’est pas dans la boîte', async () => {
      t.repo.findForRecipient.mockResolvedValueOnce(null);
      await expect(t.service.open('m-1', ALICE)).rejects.toThrow(NotFoundException);
      expect(t.repo.markRead).not.toHaveBeenCalled();
    });

    it('archive et désarchive par le même chemin', async () => {
      await t.service.setArchived('m-1', true, ALICE);
      await t.service.setArchived('m-1', false, ALICE);

      expect(t.repo.setArchived).toHaveBeenNthCalledWith(1, 'm-1', 'u-alice', true);
      expect(t.repo.setArchived).toHaveBeenNthCalledWith(2, 'm-1', 'u-alice', false);
    });

    it('n’archive PAS ce qui n’est pas dans la boîte', async () => {
      t.repo.findForRecipient.mockResolvedValueOnce(null);
      await expect(t.service.setArchived('m-1', true, ALICE)).rejects.toThrow(NotFoundException);
      expect(t.repo.setArchived).not.toHaveBeenCalled();
    });

    it('rend les compteurs À JOUR après « tout lu »', async () => {
      await t.service.markAllRead(ALICE);

      expect(t.repo.markAllRead).toHaveBeenCalledWith('u-alice');
      expect(t.repo.counts).toHaveBeenCalledWith('u-alice');
    });
  });

  describe('envoi', () => {
    it('résout « tous » en comptes actifs', async () => {
      await t.service.send(ENVOI, [], ALICE);

      expect(t.repo.allRecipients).toHaveBeenCalled();
      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as {
        recipientIds: string[];
      };
      expect(envoi.recipientIds).toContain('u-bob');
    });

    it('résout « rang » par le seuil demandé', async () => {
      await t.service.send({ ...ENVOI, audience: 'rang', audienceRank: 50 }, [], ALICE);
      expect(t.repo.recipientsByRank).toHaveBeenCalledWith(50);
    });

    it('RECOUPE les destinataires nommés avec la base', async () => {
      // Un compte supprimé ou suspendu entre la composition et l'envoi ne doit
      // pas créer une ligne qui ne correspond à personne.
      await t.service.send(
        { ...ENVOI, audience: 'comptes', recipientIds: ['u-bob', 'u-fantome'] },
        [],
        ALICE,
      );

      expect(t.repo.existingRecipients).toHaveBeenCalledWith(['u-bob', 'u-fantome']);
      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as { recipientIds: string[] };
      expect(envoi.recipientIds).not.toContain('u-fantome');
    });

    it('REFUSE un envoi dont l’audience ne désigne personne', async () => {
      // Écrire à personne réussirait en silence, et l'auteur croirait avoir
      // prévenu quelqu'un.
      t.repo.existingRecipients.mockResolvedValueOnce([]);
      await expect(
        t.service.send({ ...ENVOI, audience: 'comptes', recipientIds: ['u-fantome'] }, [], ALICE),
      ).rejects.toThrow(NotFoundException);
      expect(t.repo.createWithRecipients).not.toHaveBeenCalled();
    });

    it('AJOUTE l’auteur aux destinataires, et marque sa copie lue', async () => {
      // Sans copie, il n'aurait aucun moyen de relire ce qu'il a envoyé ; sans
      // le marquage, sa propre annonce critique l'interromprait.
      t.repo.existingRecipients.mockResolvedValueOnce(['u-bob']);
      await t.service.send({ ...ENVOI, audience: 'comptes', recipientIds: ['u-bob'] }, [], ALICE);

      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as { recipientIds: string[] };
      expect(envoi.recipientIds).toContain('u-alice');
      expect(t.repo.markRead).toHaveBeenCalledWith(expect.any(String), 'u-alice');
    });

    it('n’ajoute PAS l’auteur deux fois', async () => {
      t.repo.allRecipients.mockResolvedValueOnce(['u-alice', 'u-bob']);
      await t.service.send(ENVOI, [], ALICE);

      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as { recipientIds: string[] };
      expect(envoi.recipientIds.filter(id => id === 'u-alice')).toHaveLength(1);
    });

    it('ne conserve le rang visé QUE pour une audience de rang', async () => {
      await t.service.send({ ...ENVOI, audience: 'rang', audienceRank: 50 }, [], ALICE);
      await t.service.send(ENVOI, [], ALICE);

      expect(
        (t.repo.createWithRecipients.mock.calls[0]?.[0] as { audienceRank: number | null })
          .audienceRank,
      ).toBe(50);
      expect(
        (t.repo.createWithRecipients.mock.calls[1]?.[0] as { audienceRank: number | null })
          .audienceRank,
      ).toBeNull();
    });

    it('FIGE le nom de l’auteur à l’envoi', async () => {
      await t.service.send(ENVOI, [], ALICE);
      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as { authorName: string };

      expect(envoi.authorName).toBe('alice');
    });

    it('range les pièces jointes AVANT d’écrire en base', async () => {
      t.stockage.ranger.mockResolvedValueOnce([
        { id: 'p-1', nom: 'a.png', mime: 'image/png', taille: 10 },
      ]);

      await t.service.send(ENVOI, [{ nomAnnonce: 'a.png', octets: Buffer.from([1]) }], ALICE);

      const envoi = t.repo.createWithRecipients.mock.calls[0]?.[0] as {
        attachments: { id: string }[];
      };
      expect(envoi.attachments).toHaveLength(1);
      expect(envoi.attachments[0]?.id).toBe('p-1');
    });

    it('RETIRE les fichiers rangés si l’écriture en base échoue', async () => {
      // Sinon ils survivent sans aucune ligne pour les décrire : plus personne
      // ne les supprimera jamais.
      t.stockage.ranger.mockResolvedValueOnce([
        { id: 'p-1', nom: 'a.png', mime: 'image/png', taille: 10 },
      ]);
      t.repo.createWithRecipients.mockRejectedValueOnce(new Error('table absente'));

      await expect(
        t.service.send(ENVOI, [{ nomAnnonce: 'a.png', octets: Buffer.from([1]) }], ALICE),
      ).rejects.toThrow('table absente');

      expect(t.stockage.supprimer).toHaveBeenCalledWith(['p-1']);
    });

    it('JOURNALISE le sujet, jamais le corps', async () => {
      // Le journal d'audit dit qui a écrit à qui ; il n'archive pas la
      // correspondance.
      await t.service.send({ ...ENVOI, body: 'Information confidentielle' }, [], ALICE);

      const trace = t.audit.record.mock.calls[0]?.[0] as {
        action: string;
        details: Record<string, unknown>;
      };
      expect(trace.action).toBe('message.send');
      expect(trace.details['subject']).toBe('Bascule v2');
      expect(JSON.stringify(trace.details)).not.toContain('confidentielle');
    });

    it('JOURNALISE le nombre de destinataires SANS compter l’auteur', async () => {
      t.repo.existingRecipients.mockResolvedValueOnce(['u-bob']);
      await t.service.send({ ...ENVOI, audience: 'comptes', recipientIds: ['u-bob'] }, [], ALICE);

      const trace = t.audit.record.mock.calls[0]?.[0] as { details: Record<string, unknown> };
      expect(trace.details['destinataires']).toBe(1);
    });
  });

  describe('téléchargement d’une pièce jointe', () => {
    const PIECE = {
      id: 'p-1',
      message_id: 'm-1',
      nom: 'capture.png',
      mime: 'image/png',
      taille: 10,
    };

    it('sert la pièce d’un message que l’appelant voit', async () => {
      t.repo.findAttachment.mockResolvedValueOnce(PIECE);
      const servie = await t.service.piece('p-1', ALICE);

      expect(servie.nom).toBe('capture.png');
      expect(t.stockage.lire).toHaveBeenCalledWith('p-1', 'image/png');
    });

    it('rend le MÊME 404 pour une pièce inconnue et pour celle d’autrui', async () => {
      t.repo.findAttachment.mockResolvedValueOnce(null);
      const inconnue = await t.service.piece('p-1', ALICE).catch((e: Error) => e);

      t.repo.findAttachment.mockResolvedValueOnce(PIECE);
      t.repo.peutVoir.mockResolvedValueOnce(false);
      const autrui = await t.service.piece('p-1', ALICE).catch((e: Error) => e);

      expect(inconnue).toBeInstanceOf(NotFoundException);
      expect(autrui).toBeInstanceOf(NotFoundException);
      expect((autrui as Error).message).toBe((inconnue as Error).message);
    });

    it('ne LIT PAS le fichier quand l’accès est refusé', async () => {
      t.repo.findAttachment.mockResolvedValueOnce(PIECE);
      t.repo.peutVoir.mockResolvedValueOnce(false);

      await expect(t.service.piece('p-1', ALICE)).rejects.toThrow(NotFoundException);
      expect(t.stockage.lire).not.toHaveBeenCalled();
    });

    it('rend 404 — et non 500 — quand le fichier manque sous sa ligne', async () => {
      // Une incohérence de stockage ne dit rien d'utile à l'appelant.
      t.repo.findAttachment.mockResolvedValueOnce(PIECE);
      t.stockage.lire.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(t.service.piece('p-1', ALICE)).rejects.toThrow(NotFoundException);
    });
  });
});
