import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import * as z from 'zod';
import {
  CreateMessageSchema,
  MessageQuerySchema,
  NOMBRE_MAX_PIECES_JOINTES,
  PERMISSIONS,
  TAILLE_MAX_PIECE_JOINTE,
  type Message,
  type MessageCounts,
  type MessageListResponse,
  type MessageQuery,
} from '@websentry/shared';
import { CurrentUser, RequirePermission } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import type { FichierRecu } from './attachment-storage.service.js';
import { MessagesService, type MessageActor } from './messages.service.js';

const IdParamSchema = z.uuid();

const ArchiveSchema = z.object({ archived: z.boolean() }).strict();

/**
 * Messagerie in-app.
 *
 * La garde de permission ne porte que sur l'ENVOI : `messages:write` est le
 * code de la v1, accordé par défaut aux rangs 50 et 100. Lire sa propre boîte
 * n'exige rien — comme déposer un retour. Une permission de lecture ici
 * fermerait la boîte à ceux-là mêmes à qui l'on écrit.
 *
 * Le cloisonnement des lectures dépend de l'acteur ET de la ligne visée, ce
 * qu'une garde de route ne voit pas : il vit donc dans le service, sur la
 * jointure.
 */
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  private acteurOf(req: AuthenticatedRequest, user: AuthUser): MessageActor {
    return { id: user.sub, username: user.username, ipAddress: req.ip ?? null };
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(
    @Query({ schema: MessageQuerySchema }) requete: MessageQuery,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageListResponse> {
    return this.messages.list(requete, this.acteurOf(req, user));
  }

  /** Pastille de la barre — un seul appel, trois compteurs. */
  @Get('compteurs')
  counts(@CurrentUser() user: AuthUser, @Req() req: AuthenticatedRequest): Promise<MessageCounts> {
    return this.messages.counts(this.acteurOf(req, user));
  }

  @Get(':id')
  get(
    @Param('id', { schema: IdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Message> {
    return this.messages.get(id, this.acteurOf(req, user));
  }

  /**
   * Télécharge une pièce jointe.
   *
   * Trois en-têtes font le travail : `Content-Disposition: attachment` pour
   * qu'aucun contenu ne s'ouvre dans l'onglet de l'application, `nosniff` pour
   * qu'aucun navigateur ne réinterprète le type annoncé, et une CSP muette qui
   * neutralise un PDF porteur de script s'il était tout de même affiché.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('pieces/:id')
  async piece(
    @Param('id', { schema: IdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const piece = await this.messages.piece(id, this.acteurOf(req, user));

    await reply
      .header('Content-Type', piece.mime)
      .header('Content-Length', String(piece.contenu.byteLength))
      // Le nom est déjà nettoyé à l'écriture ; l'encoder une seconde fois ici
      // protège l'en-tête d'un nom légitime mais non ASCII.
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(piece.nom)}`,
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .send(piece.contenu);
  }

  /** Ouvrir vaut lecture — l'écriture est idempotente. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(':id/lu')
  open(
    @Param('id', { schema: IdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Message> {
    return this.messages.open(id, this.acteurOf(req, user));
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('tout-lu')
  markAllRead(
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageCounts> {
    return this.messages.markAllRead(this.acteurOf(req, user));
  }

  /** Archiver ou désarchiver — un seul geste, réversible. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch(':id')
  setArchived(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: ArchiveSchema }) body: z.infer<typeof ArchiveSchema>,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<Message> {
    return this.messages.setArchived(id, body.archived, this.acteurOf(req, user));
  }

  /**
   * Envoi d'un message, avec ou sans pièces jointes.
   *
   * La charge utile est du `multipart/form-data` : le pipe de validation global
   * ne peut donc pas s'en saisir, et le schéma partagé est appliqué ICI, sur
   * les champs extraits. Le contrôle est le même — c'est le même schéma.
   *
   * Limite serrée : un envoi touche toute une population, et chaque pièce
   * jointe consomme du disque.
   */
  @RequirePermission(PERMISSIONS.MESSAGES_WRITE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async send(@CurrentUser() user: AuthUser, @Req() req: AuthenticatedRequest): Promise<Message> {
    const { champs, fichiers } = await lireMultipart(req);

    const entree = CreateMessageSchema.safeParse(champs);
    if (!entree.success) {
      throw new BadRequestException(
        entree.error.issues.map(souci => `${souci.path.join('.') || 'corps'} : ${souci.message}`),
      );
    }

    return this.messages.send(entree.data, fichiers, this.acteurOf(req, user));
  }
}

/**
 * Extrait champs et fichiers d'un envoi `multipart/form-data`.
 *
 * Les types viennent de `@fastify/multipart`, qui augmente `FastifyRequest` :
 * redéclarer une forme locale ferait vivre une seconde vérité à côté de celle
 * du plugin, et c'est la locale qui mentirait en premier.
 *
 * Le champ `recipientIds` arrive en JSON : un formulaire ne transporte que du
 * texte, et répéter la clé produirait une forme que le schéma partagé ne
 * connaît pas. Un JSON illisible est un 400, pas un tableau vide — se replier
 * en silence enverrait le message à la mauvaise audience.
 */
async function lireMultipart(
  req: AuthenticatedRequest,
): Promise<{ champs: Record<string, unknown>; fichiers: FichierRecu[] }> {
  if (!req.isMultipart()) {
    throw new BadRequestException('Un envoi de message attend du multipart/form-data.');
  }

  const champs: Record<string, unknown> = {};
  const fichiers: FichierRecu[] = [];

  try {
    await parcourir(req, champs, fichiers);
  } catch (err) {
    throw traduire(err);
  }

  return { champs, fichiers };
}

/**
 * Traduit une erreur de `@fastify/multipart` en refus intelligible.
 *
 * Sans cela, dépasser une limite du plugin rend un 500 : une erreur du client
 * présentée comme une panne du serveur, avec ce que cela suppose de bruit dans
 * les journaux et d'inquiétude chez l'exploitant.
 */
function traduire(err: unknown): Error {
  const code = (err as { code?: string }).code;
  switch (code) {
    case 'FST_FILES_LIMIT':
    case 'FST_PARTS_LIMIT':
      return new BadRequestException(
        `Au plus ${NOMBRE_MAX_PIECES_JOINTES} pièces jointes par message.`,
      );
    case 'FST_REQ_FILE_TOO_LARGE':
      return new BadRequestException(
        `Pièce jointe trop volumineuse (maximum ${TAILLE_MAX_PIECE_JOINTE} octets).`,
      );
    case 'FST_FIELDS_LIMIT':
    case 'FST_FIELD_SIZE_LIMIT':
      return new BadRequestException('Formulaire d’envoi malformé.');
    default:
      return err instanceof Error ? err : new BadRequestException('Envoi illisible.');
  }
}

async function parcourir(
  req: AuthenticatedRequest,
  champs: Record<string, unknown>,
  fichiers: FichierRecu[],
): Promise<void> {
  for await (const partie of req.parts()) {
    if (partie.type === 'file') {
      if (fichiers.length >= NOMBRE_MAX_PIECES_JOINTES) {
        throw new BadRequestException(
          `Au plus ${NOMBRE_MAX_PIECES_JOINTES} pièces jointes par message.`,
        );
      }
      const octets = await partie.toBuffer();
      if (octets.byteLength > TAILLE_MAX_PIECE_JOINTE) {
        throw new BadRequestException(
          `Pièce jointe trop volumineuse (maximum ${TAILLE_MAX_PIECE_JOINTE} octets).`,
        );
      }
      fichiers.push({ nomAnnonce: partie.filename, octets });
      continue;
    }

    if (partie.fieldname === 'recipientIds') {
      // `value` est typé `unknown` : le convertir en chaîne à l'aveugle
      // donnerait « [object Object] » à analyser. Ce qui n'est pas du texte
      // n'est pas une liste, et le schéma le dira.
      champs['recipientIds'] = analyserListe(typeof partie.value === 'string' ? partie.value : '');
      continue;
    }
    champs[partie.fieldname] = partie.value;
  }
}

function analyserListe(brut: string): unknown {
  try {
    return JSON.parse(brut);
  } catch {
    throw new BadRequestException('recipientIds doit être un tableau JSON d’identifiants.');
  }
}
