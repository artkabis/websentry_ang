import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type CreateMessageInput,
  type Message,
  type MessageCounts,
  type MessageImportance,
  type MessageListResponse,
  type MessageQuery,
  type MimePieceJointe,
  type PieceJointe,
} from '@websentry/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  MessageRepository,
  type AttachmentRow,
  type MessageFilters,
  type MessageRow,
} from '../database/repositories/message.repository.js';
import { AttachmentStorageService, type FichierRecu } from './attachment-storage.service.js';

/** Qui agit, et sous quelle identité le message sera signé. */
export interface MessageActor {
  id: string;
  username: string;
  ipAddress: string | null;
}

/** Une pièce jointe prête à être servie. */
export interface PieceJointeServie {
  nom: string;
  mime: MimePieceJointe;
  contenu: Buffer;
}

/**
 * Messagerie in-app.
 *
 * Trois garde-fous portent ce module :
 *
 *  1. **La boîte est PERSONNELLE.** Toute lecture passe par la table des
 *     destinataires : un message qui n'a pas été adressé au compte n'existe
 *     pas pour lui. Ce n'est pas un filtre appliqué après coup — c'est la
 *     jointure elle-même.
 *  2. **L'état de lecture appartient au destinataire.** Marquer comme lu
 *     n'écrase jamais une première lecture déjà horodatée, et ne touche que sa
 *     ligne à lui.
 *  3. **Une pièce jointe ne se télécharge que par ceux qui voient le message.**
 *     Destinataire ou auteur ; personne d'autre, et un identifiant inconnu rend
 *     le même 404 qu'une pièce jointe d'autrui.
 *
 * Le sens de circulation est descendant : composer exige `messages:write`
 * (garde de route), lire n'exige rien. Un testeur qui veut répondre passe par
 * le module de retours, qui est fait pour cela.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly repo: MessageRepository,
    private readonly stockage: AttachmentStorageService,
    private readonly audit: AuditService,
  ) {}

  private requireDatabase(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException(
        'La messagerie exige une base de données (DB_ENABLED=false).',
      );
    }
  }

  async list(requete: MessageQuery, acteur: MessageActor): Promise<MessageListResponse> {
    this.requireDatabase();
    const filtres: MessageFilters = {
      userId: acteur.id,
      unread: requete.unread,
      importance: requete.importance,
      search: requete.search,
      archived: requete.archived,
    };

    const [lignes, total] = await Promise.all([
      this.repo.list(filtres, requete.limit, requete.offset),
      this.repo.count(filtres),
    ]);

    // Les pièces jointes sont ramenées en UNE requête pour toute la page : une
    // par message ferait vingt-cinq allers-retours pour afficher une liste.
    const pieces = await this.repo.attachmentsOf(lignes.map(l => l.id));
    const parMessage = grouperParMessage(pieces);

    return {
      items: lignes.map(ligne => versVue(ligne, parMessage.get(ligne.id) ?? [])),
      total,
    };
  }

  async counts(acteur: MessageActor): Promise<MessageCounts> {
    this.requireDatabase();
    const ligne = await this.repo.counts(acteur.id);

    // `SUM()` sur une boîte vide rend NULL, pas zéro : sans cette conversion,
    // la pastille afficherait « null » au premier jour d'un compte neuf.
    return {
      total: Number(ligne?.total ?? 0),
      nonLus: Number(ligne?.nonLus ?? 0),
      interrompt: Number(ligne?.interrompt ?? 0),
    };
  }

  async get(id: string, acteur: MessageActor): Promise<Message> {
    this.requireDatabase();
    const ligne = await this.requireDansLaBoite(id, acteur.id);
    return versVue(ligne, await this.repo.attachmentsOf([id]));
  }

  /**
   * Ouvrir un message le marque comme lu.
   *
   * Demander un geste supplémentaire pour dire « oui, j'ai bien lu » ferait
   * porter au lecteur le travail de tenir l'état à jour. L'écriture est
   * idempotente : la date de PREMIÈRE lecture ne bouge plus.
   */
  async open(id: string, acteur: MessageActor): Promise<Message> {
    this.requireDatabase();
    await this.requireDansLaBoite(id, acteur.id);
    await this.repo.markRead(id, acteur.id);
    return this.get(id, acteur);
  }

  async setArchived(id: string, archive: boolean, acteur: MessageActor): Promise<Message> {
    this.requireDatabase();
    await this.requireDansLaBoite(id, acteur.id);
    await this.repo.setArchived(id, acteur.id, archive);
    return this.get(id, acteur);
  }

  /** Marque toute la boîte comme lue — rend le nombre de messages touchés. */
  async markAllRead(acteur: MessageActor): Promise<MessageCounts> {
    this.requireDatabase();
    await this.repo.markAllRead(acteur.id);
    return this.counts(acteur);
  }

  /**
   * Envoie un message.
   *
   * L'audience est résolue ICI, en destinataires figés. Un compte créé demain
   * ne recevra donc pas cette annonce : une consigne datée n'a pas à surgir
   * devant un nouvel arrivant, et l'auteur a écrit pour les comptes qu'il
   * voyait au moment d'écrire.
   *
   * Les comptes SUSPENDUS sont exclus : leur écrire reviendrait à garnir une
   * boîte que personne n'ouvrira.
   *
   * **L'auteur reçoit sa propre copie, DÉJÀ LUE.** Sans elle, il n'aurait
   * aucun moyen de relire ce qu'il a envoyé — le journal d'audit conserve le
   * sujet, jamais le corps. La marquer lue lui évite d'être interrompu par sa
   * propre annonce, et fait de sa boîte la trace de ce qu'il a écrit.
   */
  async send(
    entree: CreateMessageInput,
    fichiers: readonly FichierRecu[],
    acteur: MessageActor,
  ): Promise<Message> {
    this.requireDatabase();

    const cibles = await this.resoudreAudience(entree);
    if (cibles.length === 0) {
      throw new NotFoundException('Aucun compte actif ne correspond à cette audience.');
    }
    const destinataires = [...new Set([...cibles, acteur.id])];

    const pieces = await this.stockage.ranger(fichiers);
    const id = randomUUID();

    try {
      await this.repo.createWithRecipients({
        id,
        subject: entree.subject,
        body: entree.body,
        importance: entree.importance,
        audience: entree.audience,
        // L'union discriminée garantit que seul un envoi par rang porte un
        // rang : aucun repli à écrire, donc aucune branche morte à couvrir.
        audienceRank: entree.audience === 'rang' ? entree.audienceRank : null,
        authorId: acteur.id,
        // Le nom est figé À L'ENVOI : il survit à la suppression du compte,
        // alors que la clé étrangère passera à NULL.
        authorName: acteur.username,
        recipientIds: destinataires,
        attachments: pieces,
      });
    } catch (err) {
      // L'écriture a échoué : les fichiers déjà rangés n'ont plus de ligne pour
      // les décrire, donc plus personne pour les effacer un jour.
      await this.stockage.supprimer(pieces.map(p => p.id));
      throw err;
    }

    await this.repo.markRead(id, acteur.id);

    // Le SUJET est journalisé, jamais le corps : le journal d'audit dit qui a
    // écrit à qui, il n'archive pas la correspondance.
    await this.audit.record({
      actorId: acteur.id,
      actorName: acteur.username,
      action: 'message.send',
      targetId: id,
      targetType: 'message',
      details: {
        subject: entree.subject,
        importance: entree.importance,
        audience: entree.audience,
        destinataires: cibles.length,
        piecesJointes: pieces.length,
      },
      ipAddress: acteur.ipAddress,
    });

    return this.get(id, acteur);
  }

  /**
   * Contenu d'une pièce jointe, pour qui a le droit de voir son message.
   *
   * Une pièce jointe inconnue et la pièce jointe d'un message d'autrui rendent
   * le MÊME 404 : un 403 confirmerait qu'un fichier existe sous cet
   * identifiant, ce qui est déjà une information.
   */
  async piece(id: string, acteur: MessageActor): Promise<PieceJointeServie> {
    this.requireDatabase();

    const ligne = await this.repo.findAttachment(id);
    if (!ligne || !(await this.repo.peutVoir(ligne.message_id, acteur.id))) {
      throw new NotFoundException('Pièce jointe introuvable.');
    }

    const mime = ligne.mime as MimePieceJointe;
    try {
      return { nom: ligne.nom, mime, contenu: await this.stockage.lire(ligne.id, mime) };
    } catch {
      // La ligne existe, le fichier non : c'est une incohérence de stockage, et
      // elle ne dit rien d'utile à l'appelant. Le message reste le même.
      throw new NotFoundException('Pièce jointe introuvable.');
    }
  }

  private async resoudreAudience(entree: CreateMessageInput): Promise<string[]> {
    switch (entree.audience) {
      case 'tous':
        return this.repo.allRecipients();
      case 'rang':
        return this.repo.recipientsByRank(entree.audienceRank);
      case 'comptes':
        // Les identifiants sont RECOUPÉS avec la base : un compte supprimé ou
        // suspendu entre la composition et l'envoi ne doit pas créer une ligne
        // de destinataire qui ne correspond à personne.
        return this.repo.existingRecipients(entree.recipientIds);
    }
  }

  private async requireDansLaBoite(id: string, userId: string): Promise<MessageRow> {
    const ligne = await this.repo.findForRecipient(id, userId);
    if (!ligne) throw new NotFoundException('Message introuvable.');
    return ligne;
  }
}

function grouperParMessage(pieces: readonly AttachmentRow[]): Map<string, AttachmentRow[]> {
  const parMessage = new Map<string, AttachmentRow[]>();
  for (const piece of pieces) {
    const liste = parMessage.get(piece.message_id);
    if (liste) liste.push(piece);
    else parMessage.set(piece.message_id, [piece]);
  }
  return parMessage;
}

/** Ligne de base → forme exposée. */
function versVue(ligne: MessageRow, pieces: readonly AttachmentRow[]): Message {
  return {
    id: ligne.id,
    subject: ligne.subject,
    body: ligne.body,
    importance: ligne.importance as MessageImportance,
    authorId: ligne.author_id,
    authorName: ligne.author_name,
    attachments: pieces.map(versPiece),
    sentAt: new Date(ligne.sent_at).toISOString(),
    readAt: ligne.read_at === null ? null : new Date(ligne.read_at).toISOString(),
    archivedAt: ligne.archived_at === null ? null : new Date(ligne.archived_at).toISOString(),
  };
}

function versPiece(ligne: AttachmentRow): PieceJointe {
  return {
    id: ligne.id,
    nom: ligne.nom,
    mime: ligne.mime as PieceJointe['mime'],
    taille: Number(ligne.taille),
  };
}
