import { z } from 'zod';
import { AnalysisSettingsSchema } from './settings.schema.js';

/**
 * Profils de réglages par gamme.
 *
 * Chaque gamme commerciale (premium, start, performance…) porte son propre jeu
 * de réglages. Le profil `default` est le repli universel : il s'applique quand
 * la gamme n'est pas détectée ou qu'aucun profil ne lui correspond.
 */

/** Identifiant du profil de repli — protégé contre la suppression. */
export const DEFAULT_PROFILE = 'default';

/**
 * Identifiant de gamme, sous sa forme NORMALISÉE.
 *
 * Minuscules, alphanumérique et tirets, 50 caractères au plus. La contrainte
 * n'est pas cosmétique : elle borne ce qui peut atteindre un nom de fichier
 * d'export ou un en-tête `Content-Disposition`.
 */
export const GammeSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9-]+$/, 'Gamme invalide — minuscules, chiffres et tirets uniquement');

/**
 * Gamme telle qu'elle arrive dans une URL, AVANT normalisation.
 *
 * Volontairement plus permissif que `GammeSchema` : la v1 acceptait « PREMIUM »
 * ou « START Plus! » et les normalisait. Rejeter ici casserait des clients
 * existants. On se contente donc de borner la longueur — la normalisation, puis
 * le refus de ce qui n'en laisse rien, sont le travail du service.
 */
export const GammeParamSchema = z.string().min(1).max(100);

/**
 * Normalise une gamme saisie librement.
 *
 * Reprend la règle de la v1 : minuscules, on ne garde que `[a-z0-9-]`, on tronque
 * à 50 caractères. « START Plus! » devient « startplus ».
 */
export function normalizeGamme(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 50);
}

// ── Métadonnées ──────────────────────────────────────────────────────────────

export const ProfileMetaSchema = z
  .object({
    profile: GammeSchema,
    label: z.string().min(1).max(120),
    description: z.string().max(1000).nullable(),
    /** Incrémentée à chaque écriture — support du verrouillage optimiste. */
    version: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string().max(64).nullable(),
  })
  .strict();

export type ProfileMeta = z.infer<typeof ProfileMetaSchema>;

/** Profil complet — métadonnées et réglages. */
export const SettingsProfileSchema = ProfileMetaSchema.extend({
  settings: AnalysisSettingsSchema,
}).strict();

export type SettingsProfile = z.infer<typeof SettingsProfileSchema>;

/** Réponse de `GET /profiles` — liste sans les réglages, pour rester légère. */
export const ProfileListSchema = z.array(ProfileMetaSchema);

// ── Écriture ─────────────────────────────────────────────────────────────────

/**
 * Corps de `PUT /profiles/:gamme`.
 *
 * `expectedVersion` porte le verrouillage optimiste : le client renvoie la
 * version qu'il a lue, et l'écriture est refusée (409) si le profil a changé
 * entre-temps. L'omettre revient à écraser sans condition — réservé aux
 * créations et aux imports délibérés.
 */
export const SaveProfileSchema = z
  .object({
    settings: AnalysisSettingsSchema,
    label: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export type SaveProfileInput = z.infer<typeof SaveProfileSchema>;

/** Corps de `PUT /settings` — réglages globaux, c'est-à-dire le profil `default`. */
export const SaveSettingsSchema = z
  .object({
    settings: AnalysisSettingsSchema,
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export type SaveSettingsInput = z.infer<typeof SaveSettingsSchema>;

// ── Export / import ──────────────────────────────────────────────────────────

/** Version du format d'échange — permet de refuser un fichier d'un futur format. */
export const PROFILE_EXPORT_VERSION = 1;

/**
 * Enveloppe d'export d'un profil.
 *
 * Volontairement autodescriptive : un fichier versionné dans Git ou rejoué d'un
 * environnement à l'autre doit pouvoir être relu sans contexte extérieur. La
 * `version` du profil source est exportée pour information mais n'est jamais
 * réimportée telle quelle — la base réattribue la sienne.
 */
export const ProfileExportSchema = z
  .object({
    formatVersion: z.literal(PROFILE_EXPORT_VERSION),
    exportedAt: z.string(),
    profile: GammeSchema,
    label: z.string().min(1).max(120),
    description: z.string().max(1000).nullable(),
    sourceVersion: z.number().int().min(0),
    settings: AnalysisSettingsSchema,
  })
  .strict();

export type ProfileExport = z.infer<typeof ProfileExportSchema>;

/**
 * Corps de `POST /profiles/:gamme/import`.
 *
 * La gamme de destination vient de l'URL, pas du fichier : importer un export
 * `premium` sous `start` est un cas légitime, et laisser le fichier décider de
 * sa propre destination ouvrirait un écrasement non voulu.
 */
export const ImportProfileSchema = z
  .object({
    payload: ProfileExportSchema,
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export type ImportProfileInput = z.infer<typeof ImportProfileSchema>;

// ── Registre des critères ────────────────────────────────────────────────────

/** Réponse de `GET /registry` — ce que l'éditeur de profils affiche. */
export const RegistryResponseSchema = z
  .object({
    checks: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          shortTitle: z.string().optional(),
          group: z.enum(['Design', 'Technique', 'SEO']),
          internal: z.boolean().optional(),
          mergedInto: z.string().optional(),
        })
        .strict(),
    ),
    subChecks: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          checkId: z.string(),
          absentLabel: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type RegistryResponse = z.infer<typeof RegistryResponseSchema>;
