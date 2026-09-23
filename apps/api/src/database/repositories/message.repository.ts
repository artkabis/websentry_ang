import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService, type SqlParam } from '../database.service.js';

/**
 * Messagerie in-app — trois tables, une seule porte.
 *
 * Chaque requête est paramétrée : aucune valeur d'entrée n'est interpolée dans
 * le texte SQL. La boîte se lit TOUJOURS par la table des destinataires, et
 * jamais par celle des messages : c'est la jointure qui porte le cloisonnement,
 * et non un filtre appliqué après coup sur des lignes déjà ramenées.
 */

export interface MessageRow extends RowDataPacket {
  id: string;
  subject: string;
  body: string;
  importance: string;
  author_id: string | null;
  author_name: string | null;
  sent_at: string;
  read_at: string | null;
  archived_at: string | null;
}

export interface AttachmentRow extends RowDataPacket {
  id: string;
  message_id: string;
  nom: string;
  mime: string;
  taille: number;
}

const COLONNES = `m.id, m.subject, m.body, m.importance, m.author_id, m.author_name,
                  m.sent_at, d.read_at, d.archived_at`;

export interface MessageFilters {
  /** Le destinataire dont on lit la boîte — jamais optionnel à l'usage. */
  userId: string;
  unread?: boolean;
  importance?: string;
  search?: string;
  /** `true` ne rend que les archivés ; `false` ou absent les exclut. */
  archived?: boolean;
}

@Injectable()
export class MessageRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /**
   * Filtre commun à la liste, au comptage et aux compteurs.
   *
   * Une seule fabrique pour les trois : trois constructions séparées
   * finiraient par diverger, et le total annoncé ne correspondrait plus aux
   * lignes affichées.
   */
  private static filtre(filtres: MessageFilters): { where: string; params: SqlParam[] } {
    const clauses = ['d.user_id = ?'];
    const params: SqlParam[] = [filtres.userId];

    // Archiver, c'est ranger : les archivés sortent de la vue par défaut, et il
    // faut les demander pour les voir.
    clauses.push(filtres.archived === true ? 'd.archived_at IS NOT NULL' : 'd.archived_at IS NULL');

    if (filtres.unread === true) clauses.push('d.read_at IS NULL');
    if (filtres.importance) {
      clauses.push('m.importance = ?');
      params.push(filtres.importance);
    }
    if (filtres.search) {
      clauses.push('(m.subject LIKE ? OR m.body LIKE ?)');
      // Les jokers sont posés ICI, sur une valeur paramétrée : les concaténer
      // dans le texte SQL rouvrirait l'injection que le « ? » ferme.
      const motif = `%${filtres.search}%`;
      params.push(motif, motif);
    }

    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  list(filtres: MessageFilters, limit: number, offset: number): Promise<MessageRow[]> {
    const { where, params } = MessageRepository.filtre(filtres);
    return this.db.query<MessageRow>(
      `SELECT ${COLONNES}
         FROM message_recipients d
         JOIN messages m ON m.id = d.message_id
        ${where}
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async count(filtres: MessageFilters): Promise<number> {
    const { where, params } = MessageRepository.filtre(filtres);
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM message_recipients d
         JOIN messages m ON m.id = d.message_id
        ${where}`,
      params,
    );
    return ligne?.total ?? 0;
  }

  /**
   * Compteurs de la pastille, en UNE requête.
   *
   * Trois lectures séparées se contrediraient dès qu'un message arrive entre
   * deux — la pastille annoncerait un non-lu que la liste ne contient pas.
   */
  async counts(
    userId: string,
  ): Promise<{ total: number; nonLus: number; interrompt: number } | null> {
    return this.db.queryOne<RowDataPacket & { total: number; nonLus: number; interrompt: number }>(
      `SELECT COUNT(*) AS total,
              SUM(d.read_at IS NULL) AS nonLus,
              SUM(d.read_at IS NULL AND m.importance = 'critique') AS interrompt
         FROM message_recipients d
         JOIN messages m ON m.id = d.message_id
        WHERE d.user_id = ? AND d.archived_at IS NULL`,
      [userId],
    );
  }

  /**
   * Un message TEL QUE ce destinataire le voit.
   *
   * La jointure est la garde : un message qui ne lui a pas été adressé ne
   * rend aucune ligne, et l'appelant n'a pas à comparer des identifiants.
   */
  findForRecipient(id: string, userId: string): Promise<MessageRow | null> {
    return this.db.queryOne<MessageRow>(
      `SELECT ${COLONNES}
         FROM message_recipients d
         JOIN messages m ON m.id = d.message_id
        WHERE m.id = ? AND d.user_id = ?`,
      [id, userId],
    );
  }

  attachmentsOf(messageIds: readonly string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    // Autant de « ? » que d'identifiants : la liste est construite à partir de
    // sa LONGUEUR, jamais de son contenu.
    const trous = messageIds.map(() => '?').join(', ');
    return this.db.query<AttachmentRow>(
      `SELECT id, message_id, nom, mime, taille
         FROM message_attachments
        WHERE message_id IN (${trous})
        ORDER BY created_at ASC, id ASC`,
      [...messageIds],
    );
  }

  findAttachment(id: string): Promise<AttachmentRow | null> {
    return this.db.queryOne<AttachmentRow>(
      `SELECT id, message_id, nom, mime, taille FROM message_attachments WHERE id = ?`,
      [id],
    );
  }

  /**
   * Vrai si ce compte a ce message dans sa boîte.
   *
   * Il n'y a pas de second cas « ou bien l'auteur » : l'auteur est TOUJOURS
   * parmi les destinataires de ce qu'il envoie (cf. `MessagesService.send`).
   * Une branche pour lui serait une branche qu'aucun envoi ne peut produire.
   */
  async peutVoir(messageId: string, userId: string): Promise<boolean> {
    const ligne = await this.db.queryOne<RowDataPacket & { visible: number }>(
      `SELECT EXISTS(
                SELECT 1 FROM message_recipients WHERE message_id = ? AND user_id = ?
              ) AS visible`,
      [messageId, userId],
    );
    return Number(ligne?.visible ?? 0) === 1;
  }

  /** Identifiants des comptes ACTIFS visés par une audience de rang. */
  async recipientsByRank(minRank: number): Promise<string[]> {
    const lignes = await this.db.query<RowDataPacket & { id: string }>(
      `SELECT id FROM users WHERE rank >= ? AND status = 'active'`,
      [minRank],
    );
    return lignes.map(l => l.id);
  }

  /** Identifiants des comptes ACTIFS, tous rangs confondus. */
  async allRecipients(): Promise<string[]> {
    const lignes = await this.db.query<RowDataPacket & { id: string }>(
      `SELECT id FROM users WHERE status = 'active'`,
    );
    return lignes.map(l => l.id);
  }

  /** Parmi les identifiants fournis, ceux qui désignent un compte ACTIF. */
  async existingRecipients(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const trous = ids.map(() => '?').join(', ');
    const lignes = await this.db.query<RowDataPacket & { id: string }>(
      `SELECT id FROM users WHERE id IN (${trous}) AND status = 'active'`,
      [...ids],
    );
    return lignes.map(l => l.id);
  }

  /**
   * Écrit le message, ses destinataires et ses pièces jointes — ou rien.
   *
   * Une transaction, parce qu'un message sans destinataire serait invisible et
   * indéboguable : il existerait en base sans apparaître dans aucune boîte.
   */
  async createWithRecipients(message: {
    id: string;
    subject: string;
    body: string;
    importance: string;
    audience: string;
    audienceRank: number | null;
    authorId: string | null;
    authorName: string | null;
    recipientIds: readonly string[];
    attachments: readonly { id: string; nom: string; mime: string; taille: number }[];
  }): Promise<void> {
    await this.db.transaction(async conn => {
      await conn.query(
        `INSERT INTO messages (id, subject, body, importance, audience, audience_rank, author_id, author_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.subject,
          message.body,
          message.importance,
          message.audience,
          message.audienceRank,
          message.authorId,
          message.authorName,
        ],
      );

      if (message.recipientIds.length > 0) {
        await conn.query(
          `INSERT INTO message_recipients (message_id, user_id) VALUES ${message.recipientIds
            .map(() => '(?, ?)')
            .join(', ')}`,
          message.recipientIds.flatMap(userId => [message.id, userId]),
        );
      }

      for (const piece of message.attachments) {
        await conn.query(
          `INSERT INTO message_attachments (id, message_id, nom, mime, taille)
           VALUES (?, ?, ?, ?, ?)`,
          [piece.id, message.id, piece.nom, piece.mime, piece.taille],
        );
      }
    });
  }

  /**
   * Marque comme lu — sans jamais écraser une lecture déjà horodatée.
   *
   * `read_at IS NULL` fait de l'écriture une opération idempotente : relire un
   * message ne repousse pas sa date de première lecture.
   */
  markRead(id: string, userId: string): Promise<number> {
    return this.db.execute(
      `UPDATE message_recipients SET read_at = NOW()
        WHERE message_id = ? AND user_id = ? AND read_at IS NULL`,
      [id, userId],
    );
  }

  /**
   * Archive ou désarchive — l'un annule l'autre, sans autre effet.
   *
   * Le fragment `NOW()`/`NULL` est choisi par un BOOLÉEN typé, jamais par une
   * valeur d'entrée : c'est du SQL fixe, pas une interpolation.
   */
  setArchived(id: string, userId: string, archive: boolean): Promise<number> {
    return this.db.execute(
      `UPDATE message_recipients SET archived_at = ${archive ? 'NOW()' : 'NULL'}
        WHERE message_id = ? AND user_id = ?`,
      [id, userId],
    );
  }

  /** Marque toute la boîte comme lue, d'un geste. */
  markAllRead(userId: string): Promise<number> {
    return this.db.execute(
      `UPDATE message_recipients SET read_at = NOW()
        WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL`,
      [userId],
    );
  }
}
