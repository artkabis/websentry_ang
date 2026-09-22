import * as z from 'zod';
import { PERMISSIONS, VALID_RANKS } from '../types/rbac.js';
import { PermissionCodeSchema, RankSchema, RoleSchema } from './auth.schema.js';

/**
 * Gestion des comptes — schémas partagés API ⇄ frontend.
 *
 * L'identifiant est normalisé en MINUSCULES à la validation, et non à
 * l'enregistrement : « Alice » et « alice » désignent la même personne, et
 * laisser les deux coexister rendrait un compte introuvable à qui l'a créé
 * autrement qu'il ne le tape.
 */

/** Longueur minimale d'un mot de passe créé ou réinitialisé par un administrateur. */
export const PASSWORD_MIN_LENGTH = 12;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'Identifiant invalide — lettres, chiffres, point, tiret et souligné, sans commencer ni finir par un séparateur',
  );

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères`)
  .max(256);

export const UserStatusSchema = z.enum(['active', 'suspended', 'pending']);

/** Compte tel qu'exposé — ni empreinte de mot de passe, ni compteur d'échecs. */
export const UserSummarySchema = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string().nullable(),
    email: z.email().nullable(),
    rank: RankSchema,
    role: RoleSchema,
    status: UserStatusSchema,
    /** Verrou temporaire après échecs de connexion, `null` si le compte est ouvert. */
    lockedUntil: z.iso.datetime().nullable(),
    totalScansLaunched: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type UserSummary = z.infer<typeof UserSummarySchema>;

/**
 * Rang lu depuis une CHAÎNE de requête.
 *
 * `RankSchema` attend un nombre, ce qu'un paramètre d'URL n'est jamais :
 * réutiliser tel quel rejetait `?rank=50` en 400. La coercition est bornée par
 * le même `VALID_RANKS`, donc elle n'élargit rien.
 */
const RankQuerySchema = z.coerce
  .number()
  .int()
  .refine(r => VALID_RANKS.includes(r), {
    message: `Rang invalide — attendu l'un de ${VALID_RANKS.join(', ')}`,
  });

export const UserListQuerySchema = z
  .object({
    /** Recherche sur l'identifiant, le nom affiché ou le courriel. */
    search: z.string().trim().max(64).optional(),
    rank: RankQuerySchema.optional(),
    status: UserStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type UserListQuery = z.infer<typeof UserListQuerySchema>;

export const UserListResponseSchema = z
  .object({
    users: z.array(UserSummarySchema),
    /** Total AVANT pagination — sans lui, l'interface ne sait pas quoi annoncer. */
    total: z.number().int().min(0),
  })
  .strict();

export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export const CreateUserSchema = z
  .object({
    username: UsernameSchema,
    password: PasswordSchema,
    rank: RankSchema,
    displayName: z.string().trim().max(128).optional(),
    email: z.email().max(255).optional(),
  })
  .strict();

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

/**
 * Modification d'un compte.
 *
 * Le mot de passe n'y figure PAS : le réinitialiser est un geste distinct, avec
 * sa propre route et sa propre trace d'audit. Le mêler aux autres champs
 * permettrait de le changer par inadvertance en corrigeant un courriel.
 */
export const UpdateUserSchema = z
  .object({
    rank: RankSchema.optional(),
    status: UserStatusSchema.optional(),
    displayName: z.string().trim().max(128).nullable().optional(),
    email: z.email().max(255).nullable().optional(),
  })
  .strict()
  .refine(valeurs => Object.keys(valeurs).length > 0, {
    message: 'Aucune modification demandée',
  });

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const ResetPasswordSchema = z.object({ password: PasswordSchema }).strict();

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

/**
 * Octroi d'une permission fine.
 *
 * `gammes: null` vaut « toutes les gammes ». Un tableau VIDE serait un octroi
 * qui n'accorde rien — refusé, parce que personne n'accorde exprès un droit
 * inopérant, et que le lire comme « toutes » serait l'inverse de ce qu'il dit.
 */
export const GrantPermissionSchema = z
  .object({
    permission: PermissionCodeSchema,
    gammes: z.array(z.string().trim().min(1).max(50)).min(1).max(50).nullable().default(null),
    /** Octroi temporaire ; `null` = permanent. */
    expiresAt: z.iso.datetime().nullable().default(null),
  })
  .strict();

export type GrantPermissionInput = z.infer<typeof GrantPermissionSchema>;

export const UserPermissionSchema = z
  .object({
    permission: PermissionCodeSchema,
    gammes: z.array(z.string()).nullable(),
    grantedBy: z.string().nullable(),
    grantedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();

export type UserPermission = z.infer<typeof UserPermissionSchema>;

/** Codes de permission délégables, pour alimenter l'interface d'administration. */
export const DELEGABLE_PERMISSIONS: readonly string[] = Object.values(PERMISSIONS);

/** Rangs proposés à la création, du plus faible au plus fort. */
export const ASSIGNABLE_RANKS: readonly number[] = [...VALID_RANKS].sort((a, b) => a - b);
