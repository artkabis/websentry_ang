import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../src/database/database.service.js';
import { appliquerSchema, compte, ouvrir, viderTables } from './base.js';

/**
 * Ce que le SCHÉMA garantit — vérifié par le moteur, pas par un double.
 *
 * Un double reproduit ce qu'on a compris de MariaDB. Les garanties testées ici
 * sont justement celles où cette compréhension pouvait être fausse : une
 * colonne générée, une contrainte de contrôle, des cascades de suppression.
 * Aucune n'était exercée jusqu'ici.
 */
describe('schéma MariaDB', () => {
  let db: DatabaseService;

  beforeAll(async () => {
    db = await ouvrir();
    await appliquerSchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await viderTables(db);
  });

  it('s’applique en entier, avec les tables des six schémas', async () => {
    // Le schéma est découpé par le MÊME utilitaire que le script de mise en
    // route : ce test couvre donc aussi ce découpage.
    const tables = await db.query<RowDataPacket & { nom: string }>(
      'SELECT table_name AS nom FROM information_schema.tables WHERE table_schema = DATABASE()',
    );

    // Le tri se fait ICI et non en SQL : l'ordre d'un `ORDER BY` sur une
    // colonne d'`information_schema` suit la collation de CETTE colonne, qui
    // n'est pas la nôtre — MariaDB y classe « messages » avant
    // « message_attachments ». Un test qui dépendrait de ce détail casserait au
    // premier changement de moteur, sans rien dire du schéma.
    expect(tables.map(t => t.nom).sort()).toEqual([
      'audit_log',
      'feedback',
      'message_attachments',
      'message_recipients',
      'messages',
      'scan_pages',
      'scan_sessions',
      'scan_trash',
      'settings_profiles',
      'sites',
      'user_permissions',
      'user_sessions',
      'users',
    ]);
  });

  describe('identity_key — la colonne générée', () => {
    /** Un site, réduit à ce que la clé d'identité utilise. */
    const site = (domain: string, gamme: string | null) =>
      db.execute(
        `INSERT INTO sites (id, domain, gamme, first_seen, last_seen)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [randomUUID(), domain, gamme],
      );

    it('EMPÊCHE le doublon d’un site sans gamme', async () => {
      // C'est la raison d'être de la colonne : un UNIQUE (domain, gamme) ne
      // suffirait pas, deux NULL n'étant jamais égaux en SQL. Le site « sans
      // gamme » serait alors dupliqué à chaque scan — et c'est le moteur, pas
      // notre lecture de la doc, qui doit le confirmer.
      await site('exemple.test', null);

      await expect(site('exemple.test', null)).rejects.toThrow(/Duplicate entry/i);
    });

    it('DISTINGUE le même domaine sur deux gammes', async () => {
      await site('exemple.test', 'premium');
      await site('exemple.test', 'standard');

      const lignes = await db.query<RowDataPacket & { identity_key: string }>(
        'SELECT identity_key FROM sites ORDER BY identity_key',
      );
      expect(lignes.map(l => l.identity_key)).toEqual([
        'exemple.test|premium',
        'exemple.test|standard',
      ]);
    });

    it('rend « domaine| » quand la gamme est absente', async () => {
      await site('exemple.test', null);

      const ligne = await db.queryOne<RowDataPacket & { identity_key: string }>(
        'SELECT identity_key FROM sites',
      );
      expect(ligne?.identity_key).toBe('exemple.test|');
    });
  });

  describe('contraintes de contrôle', () => {
    it('REFUSE un rang hors du catalogue', async () => {
      // `chk_rank` est la dernière barrière : au-dessus d'elle, Zod et le RBAC
      // filtrent déjà. Si elle ne tenait pas, une écriture directe en base
      // pourrait fabriquer un rang que le code ne sait pas interpréter.
      await expect(
        db.execute(
          `INSERT INTO users (id, username, password_hash, rank, status)
           VALUES (?, 'rang-invalide', 'x', 42, 'active')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/constraint|CONSTRAINT/i);
    });

    it('accepte les quatre rangs du catalogue', async () => {
      for (const rang of [10, 30, 50, 100]) {
        await compte(db, randomUUID(), { username: `compte-${rang}`, rank: rang });
      }

      const ligne = await db.queryOne<RowDataPacket & { total: number }>(
        'SELECT COUNT(*) AS total FROM users',
      );
      expect(Number(ligne?.total)).toBe(4);
    });
  });

  describe('cascades de suppression', () => {
    it('EMPORTE sessions et pages avec le site', async () => {
      const siteId = randomUUID();
      const sessionId = randomUUID();
      await db.execute(
        `INSERT INTO sites (id, domain, gamme, first_seen, last_seen)
         VALUES (?, 'cascade.test', 'premium', NOW(), NOW())`,
        [siteId],
      );
      await db.execute(
        `INSERT INTO scan_sessions (id, site_id, page_count, analyzed_at)
         VALUES (?, ?, 1, NOW())`,
        [sessionId, siteId],
      );
      await db.execute(
        `INSERT INTO scan_pages (id, session_id, url, domain, check_summary, analyzed_at)
         VALUES (?, ?, 'https://cascade.test/', 'cascade.test', '{}', NOW())`,
        [randomUUID(), sessionId],
      );

      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      const restes = await db.queryOne<RowDataPacket & { sessions: number; pages: number }>(
        `SELECT (SELECT COUNT(*) FROM scan_sessions) AS sessions,
                (SELECT COUNT(*) FROM scan_pages)    AS pages`,
      );
      expect(Number(restes?.sessions)).toBe(0);
      expect(Number(restes?.pages)).toBe(0);
    });

    it('EMPORTE la boîte d’un compte supprimé, mais CONSERVE ses messages', async () => {
      // Les deux clauses diffèrent à dessein : la boîte était personnelle, le
      // message envoyé appartient à son destinataire. Un `CASCADE` sur
      // `author_id` effacerait l'annonce reçue par toute une équipe parce que
      // son auteur a quitté l'entreprise.
      const auteur = await compte(db, randomUUID(), { username: 'auteur' });
      const destinataire = await compte(db, randomUUID(), { username: 'destinataire' });
      const messageId = randomUUID();

      await db.execute(
        `INSERT INTO messages (id, subject, body, importance, audience, author_id, author_name, sent_at)
         VALUES (?, 'Bascule', 'Jeudi 14h.', 'haute', 'tous', ?, 'auteur', NOW())`,
        [messageId, auteur],
      );
      await db.execute('INSERT INTO message_recipients (message_id, user_id) VALUES (?, ?)', [
        messageId,
        destinataire,
      ]);

      await db.execute('DELETE FROM users WHERE id = ?', [destinataire]);
      await db.execute('DELETE FROM users WHERE id = ?', [auteur]);

      const etat = await db.queryOne<
        RowDataPacket & { messages: number; boites: number; auteur: string | null }
      >(
        `SELECT (SELECT COUNT(*) FROM messages)            AS messages,
                (SELECT COUNT(*) FROM message_recipients)  AS boites,
                (SELECT author_id FROM messages LIMIT 1)   AS auteur`,
      );

      expect(Number(etat?.messages)).toBe(1);
      expect(Number(etat?.boites)).toBe(0);
      expect(etat?.auteur).toBeNull();
      // Le nom reste, lui : sans lui, un message conservé n'aurait plus
      // d'expéditeur affichable.
      const nom = await db.queryOne<RowDataPacket & { author_name: string }>(
        'SELECT author_name FROM messages',
      );
      expect(nom?.author_name).toBe('auteur');
    });
  });
});
