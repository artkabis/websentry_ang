import type { FastifyRequest } from 'fastify';

/** Identité résolue depuis un JWT valide. */
export interface AuthUser {
  /** Identifiant utilisateur (UUID). */
  sub: string;
  username: string;
  /** Rang numérique — source de vérité des autorisations. */
  rank: number;
  /** Version de jeton : invalidée côté serveur pour révoquer toutes les sessions. */
  version: number;
}

/** Permission résolue par le garde, avec son éventuel scope de gamme. */
export interface AuthPermission {
  permission: string;
  /** null = toutes les gammes autorisées ; tableau = scope restreint. */
  gammes: string[] | null;
}

/** Mode d'authentification employé — décide de l'application du contrôle CSRF. */
export type AuthVia = 'cookie' | 'bearer';

/**
 * Requête enrichie par les gardes.
 *
 * Les champs sont posés par `JwtAuthGuard` / `PermissionsGuard` et lus par les
 * contrôleurs via le décorateur `@CurrentUser()`.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  authUser?: AuthUser;
  authVia?: AuthVia;
  authPermission?: AuthPermission;
}
