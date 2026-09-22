import * as z from 'zod';

/**
 * Journal d'audit — schémas partagés API ⇄ frontend.
 *
 * La lecture du journal est réservée au rang 100 : il porte des adresses IP et
 * le détail des actions menées sur les comptes. Ce n'est pas une donnée
 * d'exploitation courante, c'est une pièce d'enquête.
 */

/** Actions tracées, telles que les écrivent les services. */
export const AuditEntrySchema = z
  .object({
    id: z.number().int(),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    action: z.string(),
    targetId: z.string().nullable(),
    targetType: z.string().nullable(),
    /**
     * Détail libre de l'action. Sa forme dépend de l'action : l'imposer ici
     * obligerait à faire évoluer ce schéma à chaque nouvelle trace, et une
     * trace refusée par sa propre validation serait pire que pas de trace.
     */
    details: z.record(z.string(), z.unknown()).nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type AuditEntryView = z.infer<typeof AuditEntrySchema>;

export const AuditListResponseSchema = z
  .object({
    entries: z.array(AuditEntrySchema),
    /** Total AVANT pagination — sans lui, l'interface ne sait pas quoi annoncer. */
    total: z.number().int().min(0),
  })
  .strict();

export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

/**
 * Filtres de lecture.
 *
 * Coercition sur les nombres : ces valeurs arrivent d'une chaîne de requête,
 * où tout est texte. `limit` est borné à 200 côté schéma ET côté service —
 * la borne du schéma protège du lien mal formé, celle du service protège de
 * tout appelant qui contournerait le schéma.
 */
export const AuditQuerySchema = z
  .object({
    actor: z.string().trim().max(64).optional(),
    action: z.string().trim().max(64).optional(),
    targetId: z.string().trim().max(64).optional(),
    /** Bornes de date INCLUSIVES, au jour près (`AAAA-MM-JJ`). */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type AuditQuery = z.infer<typeof AuditQuerySchema>;
