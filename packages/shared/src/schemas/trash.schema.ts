import * as z from 'zod';

import { ScanUuidSchema } from './scan.schema.js';

/**
 * Corbeille des scans — schémas partagés API ⇄ frontend.
 *
 * La v1 conserve les suppressions en masse avant purge, avec restauration et
 * export. La v2 avait livré les quatre portées de suppression sans ce filet,
 * et l'interface ne les proposait donc pas : offrir l'effacement définitif d'un
 * domaine entier en un clic, sans reprise possible, aurait été imprudent.
 */

/**
 * Portée du geste qui a rempli l'entrée.
 *
 * Elle décrit L'ACTION et non le contenu : supprimer un site d'une seule
 * session produit le même instantané que supprimer cette session, mais
 * l'utilisateur cherche ce qu'il a fait.
 *
 * `pages` n'en fait PAS partie : la suppression page par page reste définitive,
 * comme en v1, et l'interface l'annonce (cf. DECISIONS 70).
 */
export const TrashScopeSchema = z.enum(['session', 'site', 'domain']);
export type TrashScope = z.infer<typeof TrashScopeSchema>;

/** Une entrée de corbeille, telle que la liste l'affiche. */
export const TrashEntrySchema = z
  .object({
    id: ScanUuidSchema,
    scope: TrashScopeSchema,
    domain: z.string(),
    gamme: z.string().nullable(),
    /** Identité lisible de la cible — « domaine|gamme », ou le domaine seul. */
    label: z.string(),
    sessionCount: z.number().int().min(0),
    pageCount: z.number().int().min(0),
    /** Taille de l'instantané AVANT compression, en octets. */
    payloadBytes: z.number().int().min(0),
    deletedAt: z.string(),
    deletedBy: ScanUuidSchema.nullable(),
    deletedByName: z.string().nullable(),
    purgeAfter: z.string(),
  })
  .strict();

export type TrashEntry = z.infer<typeof TrashEntrySchema>;

export const TrashListQuerySchema = z
  .object({
    domain: z.string().max(255).optional(),
    gamme: z.string().max(50).optional(),
    scope: TrashScopeSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type TrashListQuery = z.infer<typeof TrashListQuerySchema>;

export const TrashListResponseSchema = z
  .object({
    items: z.array(TrashEntrySchema),
    total: z.number().int().min(0),
  })
  .strict();

export type TrashListResponse = z.infer<typeof TrashListResponseSchema>;

/**
 * Résultat d'une restauration.
 *
 * `skipped` n'est pas un détail : une session peut avoir été rescannée depuis
 * sa suppression. On ne l'écrase pas — on le dit. Annoncer « restauré » sans
 * distinguer laisserait croire à une reprise complète.
 */
export const TrashRestoreResultSchema = z
  .object({
    sites: z.number().int().min(0),
    sessions: z.number().int().min(0),
    pages: z.number().int().min(0),
    skippedSessions: z.number().int().min(0),
  })
  .strict();

export type TrashRestoreResult = z.infer<typeof TrashRestoreResultSchema>;

/**
 * Instantané exporté.
 *
 * Volontairement OUVERT sur les lignes : elles sont capturées par `SELECT *`,
 * et figer ici la liste des colonnes obligerait à modifier le schéma partagé
 * chaque fois qu'une colonne est ajoutée à l'historique — la restauration
 * perdrait silencieusement la nouvelle.
 */
export const TrashExportSchema = z
  .object({
    /** Version du format, pour qu'un export relu plus tard sache se lire. */
    format: z.literal(1),
    scope: TrashScopeSchema,
    label: z.string(),
    deletedAt: z.string(),
    sites: z.array(z.record(z.string(), z.unknown())),
    sessions: z.array(z.record(z.string(), z.unknown())),
    pages: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

export type TrashExport = z.infer<typeof TrashExportSchema>;
