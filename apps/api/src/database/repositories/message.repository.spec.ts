import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { MessageRepository } from './message.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
    transaction: vi.fn(),
  };
  return { repo: new MessageRepository(db as unknown as DatabaseService), db };
}

/** Clause WHERE isolée, espaces normalisés. */
function whereDe(sql: string): string {
  return (/WHERE .*?(?= ORDER BY| GROUP BY|$)/s.exec(sql)?.[0] ?? '').replace(/\s+/g, ' ').trim();
}

const BOITE = 'u-1';

describe('MessageRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('lecture de la boîte', () => {
    it('part TOUJOURS de la table des destinataires', async () => {
      // C'est la jointure qui porte le cloisonnement : lire `messages` puis
      // filtrer ramènerait d'abord le courrier des autres.
      await t.repo.list({ userId: BOITE }, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('FROM message_recipients d');
      expect(sql).toContain('JOIN messages m ON m.id = d.message_id');
      expect(whereDe(sql)).toContain('d.user_id = ?');
      expect(params[0]).toBe(BOITE);
    });

    it('EXCLUT les archivés par défaut, et ne rend qu’eux sur demande', async () => {
      await t.repo.list({ userId: BOITE }, 25, 0);
      expect(whereDe((t.db.query.mock.calls[0] as [string])[0])).toContain('d.archived_at IS NULL');

      await t.repo.list({ userId: BOITE, archived: true }, 25, 0);
      expect(whereDe((t.db.query.mock.calls[1] as [string])[0])).toContain(
        'd.archived_at IS NOT NULL',
      );
    });

    it('ne filtre sur les non-lus QUE si on le demande', async () => {
      await t.repo.list({ userId: BOITE, unread: false }, 25, 0);
      expect(whereDe((t.db.query.mock.calls[0] as [string])[0])).not.toContain('read_at IS NULL');

      await t.repo.list({ userId: BOITE, unread: true }, 25, 0);
      expect(whereDe((t.db.query.mock.calls[1] as [string])[0])).toContain('d.read_at IS NULL');
    });

    it('rend le plus récent d’abord, départagé par identifiant', async () => {
      // Deux messages envoyés à la même seconde doivent garder un ordre stable,
      // sans quoi la pagination peut en sauter ou en répéter.
      await t.repo.list({ userId: BOITE }, 25, 0);
      expect((t.db.query.mock.calls[0] as [string])[0]).toContain(
        'ORDER BY m.sent_at DESC, m.id DESC',
      );
    });

    it('PARAMÈTRE la recherche, jokers compris', async () => {
      await t.repo.list({ userId: BOITE, search: "consigne' OR 1=1 --" }, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).not.toContain('OR 1=1');
      expect(params).toContain("%consigne' OR 1=1 --%");
    });

    it('PARAMÈTRE l’importance', async () => {
      await t.repo.list({ userId: BOITE, importance: "critique' --" }, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('m.importance = ?');
      expect(params).toContain("critique' --");
    });

    it('compte avec EXACTEMENT le même filtre que la liste', async () => {
      // Un total calculé sur un autre filtre annoncerait des pages qui
      // n'existent pas.
      const filtres = { userId: BOITE, unread: true as const, search: 'bascule' };
      await t.repo.list(filtres, 25, 0);
      await t.repo.count(filtres);

      const liste = whereDe((t.db.query.mock.calls[0] as [string])[0]);
      const total = whereDe((t.db.queryOne.mock.calls[0] as [string])[0]);
      expect(total).toBe(liste);
    });

    it('rend zéro quand le comptage ne ramène aucune ligne', async () => {
      t.db.queryOne.mockResolvedValueOnce(null);
      await expect(t.repo.count({ userId: BOITE })).resolves.toBe(0);
    });
  });

  describe('compteurs de la pastille', () => {
    it('les obtient en UNE requête, archivés exclus', async () => {
      // Trois lectures séparées se contrediraient dès qu'un message arrive
      // entre deux.
      await t.repo.counts(BOITE);
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      expect(t.db.queryOne).toHaveBeenCalledTimes(1);
      expect(sql).toContain('COUNT(*) AS total');
      expect(sql).toContain('SUM(d.read_at IS NULL) AS nonLus');
      expect(sql).toContain("m.importance = 'critique'");
      expect(sql).toContain('d.archived_at IS NULL');
      expect(params).toEqual([BOITE]);
    });
  });

  describe('accès unitaire', () => {
    it('exige le message ET le destinataire', async () => {
      await t.repo.findForRecipient('m-1', BOITE);
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('WHERE m.id = ? AND d.user_id = ?');
      expect(params).toEqual(['m-1', BOITE]);
    });

    it('ne reconnaît QUE le destinataire — pas d’exception pour l’auteur', async () => {
      // L'auteur est toujours parmi ses propres destinataires : une seconde
      // branche pour lui serait inatteignable.
      await t.repo.peutVoir('m-1', BOITE);
      const [sql] = t.db.queryOne.mock.calls[0] as [string];

      expect(sql).toContain('FROM message_recipients');
      expect(sql).not.toContain('author_id');
    });

    it('rend faux quand la requête de visibilité ne ramène rien', async () => {
      t.db.queryOne.mockResolvedValueOnce(null);
      await expect(t.repo.peutVoir('m-1', BOITE)).resolves.toBe(false);
    });

    it('rend vrai sur une visibilité confirmée', async () => {
      t.db.queryOne.mockResolvedValueOnce({ visible: 1 });
      await expect(t.repo.peutVoir('m-1', BOITE)).resolves.toBe(true);
    });
  });

  describe('pièces jointes', () => {
    it('n’interroge PAS la base pour une page sans message', async () => {
      await expect(t.repo.attachmentsOf([])).resolves.toEqual([]);
      expect(t.db.query).not.toHaveBeenCalled();
    });

    it('pose autant de « ? » que d’identifiants', async () => {
      await t.repo.attachmentsOf(['a', 'b', 'c']);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      // La liste est construite à partir de sa LONGUEUR, jamais de son contenu.
      expect(sql).toContain('WHERE message_id IN (?, ?, ?)');
      expect(params).toEqual(['a', 'b', 'c']);
    });

    it('lit une pièce jointe par son identifiant seul', async () => {
      await t.repo.findAttachment('p-1');
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      // Le CHEMIN de stockage n'est pas une colonne : il n'y a rien à lire.
      expect(sql).not.toContain('chemin');
      expect(params).toEqual(['p-1']);
    });
  });

  describe('résolution d’audience', () => {
    it('ne retient que les comptes ACTIFS, quel que soit le mode', async () => {
      await t.repo.allRecipients();
      await t.repo.recipientsByRank(50);
      await t.repo.existingRecipients(['u-1', 'u-2']);

      for (const appel of t.db.query.mock.calls) {
        expect((appel as [string])[0]).toContain("status = 'active'");
      }
    });

    it('PARAMÈTRE le rang visé', async () => {
      await t.repo.recipientsByRank(50);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('rank >= ?');
      expect(params).toEqual([50]);
    });

    it('n’interroge PAS la base pour une liste vide', async () => {
      await expect(t.repo.existingRecipients([])).resolves.toEqual([]);
      expect(t.db.query).not.toHaveBeenCalled();
    });

    it.each([
      ['allRecipients', (r: MessageRepository) => r.allRecipients()],
      ['recipientsByRank', (r: MessageRepository) => r.recipientsByRank(50)],
      ['existingRecipients', (r: MessageRepository) => r.existingRecipients(['u-1', 'u-2'])],
    ])('rend les identifiants tels quels — %s', async (_nom, appel) => {
      t.db.query.mockResolvedValueOnce([{ id: 'u-1' }, { id: 'u-2' }]);
      await expect(appel(t.repo)).resolves.toEqual(['u-1', 'u-2']);
    });
  });

  describe('écriture', () => {
    it('écrit message, destinataires et pièces dans UNE transaction', async () => {
      // Un message sans destinataire existerait en base sans apparaître dans
      // aucune boîte : introuvable, et indéboguable.
      const conn = { query: vi.fn().mockResolvedValue([]) };
      t.db.transaction.mockImplementation(
        (fn: (c: typeof conn) => Promise<unknown>) => fn(conn) as Promise<void>,
      );

      await t.repo.createWithRecipients({
        id: 'm-1',
        subject: 'Bascule',
        body: 'Jeudi',
        importance: 'haute',
        audience: 'comptes',
        audienceRank: null,
        authorId: 'u-1',
        authorName: 'alice',
        recipientIds: ['u-2', 'u-3'],
        attachments: [{ id: 'p-1', nom: 'capture.png', mime: 'image/png', taille: 10 }],
      });

      expect(t.db.transaction).toHaveBeenCalledTimes(1);
      const requetes = conn.query.mock.calls.map(appel => (appel as [string])[0]);
      expect(requetes[0]).toContain('INSERT INTO messages');
      expect(requetes[1]).toContain('INSERT INTO message_recipients');
      expect(requetes[2]).toContain('INSERT INTO message_attachments');
    });

    it('insère les destinataires en UNE requête, paramétrée', async () => {
      const conn = { query: vi.fn().mockResolvedValue([]) };
      t.db.transaction.mockImplementation(
        (fn: (c: typeof conn) => Promise<unknown>) => fn(conn) as Promise<void>,
      );

      await t.repo.createWithRecipients({
        id: 'm-1',
        subject: 'S',
        body: 'B',
        importance: 'normale',
        audience: 'tous',
        audienceRank: null,
        authorId: null,
        authorName: null,
        recipientIds: ['u-2', 'u-3'],
        attachments: [],
      });

      const [sql, params] = conn.query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('VALUES (?, ?), (?, ?)');
      expect(params).toEqual(['m-1', 'u-2', 'm-1', 'u-3']);
    });

    it('n’écrit AUCUNE ligne de destinataire quand la liste est vide', async () => {
      const conn = { query: vi.fn().mockResolvedValue([]) };
      t.db.transaction.mockImplementation(
        (fn: (c: typeof conn) => Promise<unknown>) => fn(conn) as Promise<void>,
      );

      await t.repo.createWithRecipients({
        id: 'm-1',
        subject: 'S',
        body: 'B',
        importance: 'normale',
        audience: 'tous',
        audienceRank: null,
        authorId: null,
        authorName: null,
        recipientIds: [],
        attachments: [],
      });

      expect(conn.query).toHaveBeenCalledTimes(1);
    });

    it('ne marque lu QUE ce qui ne l’était pas', async () => {
      // Sans cette clause, relire un message repousserait la date de PREMIÈRE
      // lecture.
      await t.repo.markRead('m-1', BOITE);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('read_at IS NULL');
      expect(params).toEqual(['m-1', BOITE]);
    });

    it('archive et désarchive par le même chemin', async () => {
      await t.repo.setArchived('m-1', BOITE, true);
      await t.repo.setArchived('m-1', BOITE, false);

      expect((t.db.execute.mock.calls[0] as [string])[0]).toContain('archived_at = NOW()');
      expect((t.db.execute.mock.calls[1] as [string])[0]).toContain('archived_at = NULL');
    });

    it('ne marque « tout lu » que la boîte VISIBLE du compte', async () => {
      // Les archivés restent dans leur état : « tout lu » vaut pour ce qu'on a
      // sous les yeux.
      await t.repo.markAllRead(BOITE);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('user_id = ?');
      expect(sql).toContain('read_at IS NULL');
      expect(sql).toContain('archived_at IS NULL');
      expect(params).toEqual([BOITE]);
    });
  });
});
