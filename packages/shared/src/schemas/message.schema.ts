import * as z from 'zod';

import { VALID_RANKS } from '../types/rbac.js';

/**
 * Messagerie in-app — schémas partagés API ⇄ frontend.
 *
 * Le sens de circulation est DONNÉ par le catalogue de permissions de la v1 :
 * `messages:write` n'est accordé par défaut qu'aux rangs 50 et 100. Un testeur
 * ne compose donc pas — il reçoit. La messagerie est un canal descendant
 * (consigne, annonce de version, information ciblée), pas une discussion.
 *
 * Ce choix a un coût, assumé et consigné dans `DECISIONS.md` : répondre à un
 * message passe par le module de retours, qui existe pour cela.
 */

/**
 * Importance — elle pilote l'IRRUPTION, pas seulement la couleur.
 *
 * Trois niveaux, parce qu'ils se distinguent par un comportement observable et
 * non par une nuance : `normale` attend dans la boîte, `haute` se signale en
 * tête de liste, `critique` s'impose à l'écran jusqu'à ce qu'on l'ait lue.
 * Un quatrième niveau n'aurait aucun comportement propre à décrire.
 */
export const MessageImportanceSchema = z.enum(['normale', 'haute', 'critique']);
export type MessageImportance = z.infer<typeof MessageImportanceSchema>;

/**
 * Un message s'impose-t-il à l'écran ?
 *
 * La règle vit ICI et non dans le composant : le serveur s'en sert pour
 * décider ce qu'il remonte en priorité, l'interface pour décider ce qu'elle
 * affiche. Deux copies de la même règle divergeraient.
 */
export function sInterrompt(importance: MessageImportance): boolean {
  return importance === 'critique';
}

/**
 * À qui s'adresse un message.
 *
 * L'audience est RÉSOLUE À L'ENVOI, en lignes de destinataires. Un compte créé
 * demain ne reçoit donc pas une annonce d'hier — ce qui est le comportement
 * attendu : une consigne datée n'a pas à surgir devant un nouvel arrivant.
 */
export const MessageAudienceSchema = z.enum(['tous', 'rang', 'comptes']);
export type MessageAudience = z.infer<typeof MessageAudienceSchema>;

// ── Pièces jointes ───────────────────────────────────────────────────────────

/** Au-delà, ce n'est plus une pièce jointe mais un transfert de fichiers. */
export const TAILLE_MAX_PIECE_JOINTE = 5 * 1024 * 1024;
export const NOMBRE_MAX_PIECES_JOINTES = 3;

/**
 * Types acceptés, reconnus par leur EMPREINTE et non par leur extension.
 *
 * L'extension et l'en-tête `Content-Type` sont fournis par l'appelant : les
 * croire reviendrait à laisser choisir le type de ce qu'on stocke. La signature
 * est lue dans les premiers octets du fichier, qui, eux, ne se déclarent pas.
 *
 * La liste est courte À DESSEIN : capture d'écran et rapport. Tout ajout se
 * pèse, car chaque type admis est un format de plus à ne pas mal servir.
 */
export const TYPES_PIECE_JOINTE = {
  'image/png': {
    extension: 'png',
    signatures: [{ offset: 0, octets: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  'image/jpeg': {
    extension: 'jpg',
    signatures: [{ offset: 0, octets: [0xff, 0xd8, 0xff] }],
  },
  'image/webp': {
    // Un conteneur RIFF ne suffit pas : « WEBP » au neuvième octet distingue
    // une image d'un fichier audio qui partagerait le même en-tête.
    extension: 'webp',
    signatures: [
      { offset: 0, octets: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, octets: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  'application/pdf': {
    extension: 'pdf',
    signatures: [{ offset: 0, octets: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
  },
} as const;

export type MimePieceJointe = keyof typeof TYPES_PIECE_JOINTE;

export const MIMES_PIECE_JOINTE = Object.keys(TYPES_PIECE_JOINTE) as readonly MimePieceJointe[];

export const MimePieceJointeSchema = z.enum(
  Object.keys(TYPES_PIECE_JOINTE) as [MimePieceJointe, ...MimePieceJointe[]],
);

/**
 * Type réellement contenu par ces octets, ou `null`.
 *
 * `null` n'est pas une erreur technique : c'est un refus. L'appelant décide
 * quoi en faire, et il n'a jamais à lire l'extension pour trancher.
 */
export function typeReconnu(octets: Uint8Array): MimePieceJointe | null {
  for (const mime of MIMES_PIECE_JOINTE) {
    const { signatures } = TYPES_PIECE_JOINTE[mime];
    const concorde = signatures.every(({ offset, octets: attendus }) =>
      attendus.every((attendu, i) => octets[offset + i] === attendu),
    );
    if (concorde) return mime;
  }
  return null;
}

/**
 * Nom montrable, dérivé du nom fourni par l'appelant.
 *
 * Le nom d'origine n'est JAMAIS un chemin de stockage — le fichier est rangé
 * sous un identifiant généré. Il n'en reste pas moins affiché et renvoyé dans
 * un en-tête `Content-Disposition` : séparateurs, caractères de contrôle et
 * guillemets en sont donc retirés, sans quoi le nom pourrait sortir du dossier
 * chez celui qui télécharge, ou couper l'en-tête en deux.
 */
export function nomAffichable(nom: string): string {
  const nettoye = nom
    // eslint-disable-next-line no-control-regex -- Les caractères de contrôle sont précisément la cible.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/["]/g, '')
    .trim();
  // Un nom réduit à rien par le nettoyage ne laisse pas un en-tête vide.
  return (nettoye.length > 0 ? nettoye : 'piece-jointe').slice(0, 120);
}

export const PieceJointeSchema = z
  .object({
    id: z.uuid(),
    /** Nom d'origine, déjà nettoyé — affichage et téléchargement seulement. */
    nom: z.string(),
    mime: MimePieceJointeSchema,
    taille: z.number().int().min(1).max(TAILLE_MAX_PIECE_JOINTE),
  })
  .strict();

export type PieceJointe = z.infer<typeof PieceJointeSchema>;

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Rang visé par un envoi.
 *
 * La coercition ne porte que sur une CHAÎNE NON VIDE : un formulaire multipart
 * ne transporte que du texte, mais `Number(undefined)` vaut `NaN`, et le refus
 * se lirait alors « nombre attendu, NaN reçu » là où il faut lire « champ
 * manquant ».
 */
const RangCibleSchema = z.preprocess(
  valeur => (typeof valeur === 'string' && valeur.trim() !== '' ? Number(valeur) : valeur),
  z
    .number()
    .int()
    .refine(r => VALID_RANKS.includes(r), {
      message: `Rang invalide — attendu l'un de ${VALID_RANKS.join(', ')}`,
    }),
);

const ChampsCommuns = {
  subject: z.string().trim().min(3).max(150),
  /**
   * 10 000 caractères : une annonce de version tient largement, un rapport
   * collé par mégarde ne passe pas.
   */
  body: z.string().trim().min(1).max(10_000),
  importance: MessageImportanceSchema.default('normale'),
};

/**
 * Composition — une UNION DISCRIMINÉE par l'audience.
 *
 * Chaque audience porte sa propre cible, et elle seule : le rang n'existe que
 * dans la branche « rang », la liste de comptes que dans la branche
 * « comptes ». Une vérification croisée écrite à la main — « si audience vaut
 * rang alors audienceRank est requis » — dirait la même chose, mais en laissant
 * le TYPE admettre les combinaisons interdites ; le code devrait alors les
 * traiter, avec des replis que rien ne peut atteindre.
 *
 * Refuser la cible qu'une audience n'attend pas n'est pas du zèle : un envoi
 * « à tous » accompagné d'un rang laisserait croire qu'il a été restreint.
 */
export const CreateMessageSchema = z.discriminatedUnion('audience', [
  z.object({ ...ChampsCommuns, audience: z.literal('tous') }).strict(),
  z
    .object({
      ...ChampsCommuns,
      audience: z.literal('rang'),
      /** Rang minimal visé. */
      audienceRank: RangCibleSchema,
    })
    .strict(),
  z
    .object({
      ...ChampsCommuns,
      audience: z.literal('comptes'),
      /** Comptes visés, nommément. */
      recipientIds: z.array(z.uuid()).min(1).max(200),
    })
    .strict(),
]);

export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;

// ── Lecture ──────────────────────────────────────────────────────────────────

/**
 * Un message TEL QUE SON DESTINATAIRE le voit.
 *
 * L'état de lecture appartient au destinataire, pas au message : deux comptes
 * lisent le même envoi, chacun avec son `readAt`. La vue les réunit pour que
 * l'interface n'ait pas à recoller deux collections.
 */
export const MessageSchema = z
  .object({
    id: z.uuid(),
    subject: z.string(),
    body: z.string(),
    importance: MessageImportanceSchema,
    authorId: z.string().nullable(),
    /** Nom au moment de l'envoi — il survit à la suppression du compte. */
    authorName: z.string().nullable(),
    attachments: z.array(PieceJointeSchema),
    sentAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type Message = z.infer<typeof MessageSchema>;

export const MessageListResponseSchema = z
  .object({
    items: z.array(MessageSchema),
    /** Total AVANT pagination — sans lui, l'interface ne sait quoi annoncer. */
    total: z.number().int().min(0),
  })
  .strict();

export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

export const MessageQuerySchema = z
  .object({
    /** `true` ne rend que les non lus ; `false` ne filtre rien. */
    unread: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform(v => v === true || v === 'true')
      .optional(),
    importance: MessageImportanceSchema.optional(),
    search: z.string().trim().max(100).optional(),
    /** Les archivés sont EXCLUS par défaut : archiver, c'est ranger. */
    archived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform(v => v === true || v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type MessageQuery = z.infer<typeof MessageQuerySchema>;

/**
 * De quoi peindre la pastille de la barre, en un appel.
 *
 * `interrompt` porte le nombre de messages qui doivent s'imposer à l'écran :
 * l'interface n'a pas à relire toute la boîte pour savoir s'il faut ouvrir la
 * fenêtre surgissante.
 */
export const MessageCountsSchema = z
  .object({
    total: z.number().int().min(0),
    nonLus: z.number().int().min(0),
    interrompt: z.number().int().min(0),
  })
  .strict();

export type MessageCounts = z.infer<typeof MessageCountsSchema>;
