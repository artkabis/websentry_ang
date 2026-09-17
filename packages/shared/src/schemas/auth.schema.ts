import { z } from 'zod';
import { PERMISSIONS, VALID_RANKS } from '../types/rbac.js';

/**
 * Schémas Zod partagés API ⇄ frontend.
 *
 * Source unique de vérité : le backend les consomme via `nestjs-zod` (DTO +
 * ValidationPipe), le frontend Angular via `parse()` sur les réponses HTTP.
 * Aucune duplication class-validator : un seul schéma, deux consommateurs.
 */

/** Identifiants de connexion. Bornes strictes = première ligne anti-mass-assignment. */
export const LoginSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict(); // rejette toute clé surnuméraire (mass assignment)

export type LoginInput = z.infer<typeof LoginSchema>;

export const RoleSchema = z.enum(['tester', 'editor', 'admin', 'super_admin']);

export const RankSchema = z
  .number()
  .int()
  .refine(r => VALID_RANKS.includes(r), {
    message: `Rang invalide — attendu l'un de ${VALID_RANKS.join(', ')}`,
  });

export const PermissionCodeSchema = z.enum(
  Object.values(PERMISSIONS) as [string, ...string[]],
);

/** Permission telle qu'exposée au frontend : code + scope gamme (null = toutes). */
export const GrantedPermissionSchema = z
  .object({
    permission: PermissionCodeSchema,
    gammes: z.array(z.string()).nullable(),
  })
  .strict();

export type GrantedPermission = z.infer<typeof GrantedPermissionSchema>;

/** Réponse de `POST /auth/login` et `POST /auth/refresh` — volontairement minimale. */
export const AuthSessionSchema = z
  .object({
    role: RoleSchema,
    username: z.string(),
  })
  .strict();

export type AuthSession = z.infer<typeof AuthSessionSchema>;

/**
 * Réponse de `GET /auth/me`.
 *
 * DTO de sortie explicite : aucun champ sensible de la table `users`
 * (password_hash, token_version, failed_logins, locked_until) ne transite ici.
 */
export const CurrentUserSchema = z
  .object({
    id: z.string().nullable(),
    username: z.string(),
    rank: RankSchema,
    role: RoleSchema,
    status: z.enum(['active', 'suspended', 'pending']),
    permissions: z.array(GrantedPermissionSchema),
  })
  .strict();

export type CurrentUser = z.infer<typeof CurrentUserSchema>;

/** Forme d'erreur unifiée de l'API — jamais de stack trace, jamais de détail interne. */
export const ApiErrorSchema = z
  .object({
    statusCode: z.number().int(),
    error: z.string(),
    message: z.string(),
    /** Identifiant de corrélation : permet de retrouver la trace serveur côté logs. */
    requestId: z.string().optional(),
  })
  .strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;
