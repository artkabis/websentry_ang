import * as z from 'zod';

/**
 * Retours des bêta-testeurs — schémas partagés API ⇄ frontend.
 *
 * Le module existe pour une raison précise : une équipe qualité qui enchaîne
 * les audits rencontre des cas limites que personne n'a prévus. Si signaler
 * coûte plus cher que contourner, elle contourne, et le défaut reste.
 * Le formulaire est donc court, et le contexte (page, gamme) est capturé
 * AUTOMATIQUEMENT plutôt que redemandé.
 */

export const FeedbackKindSchema = z.enum(['bug', 'suggestion', 'question']);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

/**
 * Gravité — déclarée par l'auteur, ajustable au triage.
 *
 * Quatre niveaux et pas davantage : au-delà, personne ne distingue plus les
 * paliers et tout finit au milieu.
 */
export const FeedbackSeveritySchema = z.enum(['bloquant', 'majeur', 'mineur', 'cosmetique']);
export type FeedbackSeverity = z.infer<typeof FeedbackSeveritySchema>;

/**
 * Statut de traitement.
 *
 * `rejete` existe et ne se confond PAS avec `resolu` : refuser un retour est
 * une réponse légitime, et la noyer dans « résolu » ferait croire à l'auteur
 * que son cas a été traité.
 */
export const FeedbackStatusSchema = z.enum(['nouveau', 'accepte', 'en_cours', 'resolu', 'rejete']);
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;

/** Transitions autorisées — un statut ne se remonte pas au hasard. */
export const TRANSITIONS_STATUT: Readonly<Record<FeedbackStatus, readonly FeedbackStatus[]>> = {
  nouveau: ['accepte', 'rejete'],
  accepte: ['en_cours', 'rejete'],
  en_cours: ['resolu', 'rejete'],
  // Rouvrir reste possible : un correctif qui ne corrige pas se constate après
  // coup, et forcer la création d'un doublon perdrait le fil de la discussion.
  resolu: ['en_cours'],
  rejete: ['nouveau'],
};

export function transitionAutorisee(depuis: FeedbackStatus, vers: FeedbackStatus): boolean {
  return TRANSITIONS_STATUT[depuis].includes(vers);
}

/** Contexte capturé automatiquement — ce que l'auteur n'a pas à ressaisir. */
export const FeedbackContextSchema = z
  .object({
    /** Route de l'application au moment du dépôt. */
    route: z.string().trim().max(200).nullable().default(null),
    /** URL auditée, quand le retour vient d'un écran d'analyse. */
    targetUrl: z.url().max(2048).nullable().default(null),
    gamme: z.string().trim().max(50).nullable().default(null),
  })
  .strict();

export type FeedbackContext = z.infer<typeof FeedbackContextSchema>;

export const CreateFeedbackSchema = z
  .object({
    kind: FeedbackKindSchema,
    severity: FeedbackSeveritySchema,
    title: z.string().trim().min(5).max(150),
    /**
     * Le corps est BORNÉ à 5000 caractères : au-delà, ce n'est plus un retour
     * mais un rapport, et il passe par un autre canal. La borne protège aussi
     * la table d'un collage accidentel de rapport d'analyse complet.
     */
    body: z.string().trim().min(10).max(5000),
    context: FeedbackContextSchema.optional(),
  })
  .strict();

export type CreateFeedbackInput = z.infer<typeof CreateFeedbackSchema>;

/**
 * Triage — ce qu'un responsable peut changer.
 *
 * Ni le titre ni le corps : ils appartiennent à l'auteur, et les réécrire
 * effacerait ce qu'il a réellement signalé.
 */
export const TriageFeedbackSchema = z
  .object({
    status: FeedbackStatusSchema.optional(),
    severity: FeedbackSeveritySchema.optional(),
    /** `null` désassigne ; absent ne touche à rien. */
    assignedTo: z.uuid().nullable().optional(),
    /** Réponse visible par l'auteur — c'est elle qui ferme la boucle. */
    resolution: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine(valeurs => Object.keys(valeurs).length > 0, {
    message: 'Aucune modification demandée',
  });

export type TriageFeedbackInput = z.infer<typeof TriageFeedbackSchema>;

export const FeedbackSchema = z
  .object({
    id: z.uuid(),
    kind: FeedbackKindSchema,
    severity: FeedbackSeveritySchema,
    status: FeedbackStatusSchema,
    title: z.string(),
    body: z.string(),
    context: FeedbackContextSchema,
    authorId: z.string().nullable(),
    /** Nom au moment du dépôt — il survit à la suppression du compte. */
    authorName: z.string().nullable(),
    assignedTo: z.string().nullable(),
    assignedName: z.string().nullable(),
    resolution: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type Feedback = z.infer<typeof FeedbackSchema>;

export const FeedbackListResponseSchema = z
  .object({
    items: z.array(FeedbackSchema),
    /** Total AVANT pagination — sans lui, l'interface ne sait quoi annoncer. */
    total: z.number().int().min(0),
  })
  .strict();

export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>;

/** Filtres de lecture — coercition sur les nombres, qui arrivent en texte. */
export const FeedbackQuerySchema = z
  .object({
    status: FeedbackStatusSchema.optional(),
    kind: FeedbackKindSchema.optional(),
    severity: FeedbackSeveritySchema.optional(),
    search: z.string().trim().max(100).optional(),
    /** `true` restreint aux retours de l'appelant. */
    mine: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform(v => v === true || v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type FeedbackQuery = z.infer<typeof FeedbackQuerySchema>;

/** Compteurs par statut, pour l'en-tête de l'écran de triage. */
export const FeedbackCountsSchema = z
  .object({
    nouveau: z.number().int().min(0),
    accepte: z.number().int().min(0),
    en_cours: z.number().int().min(0),
    resolu: z.number().int().min(0),
    rejete: z.number().int().min(0),
  })
  .strict();

export type FeedbackCounts = z.infer<typeof FeedbackCountsSchema>;
