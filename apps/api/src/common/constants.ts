/** Noms de cookies — conservés à l'identique de la v1 (compatibilité des sessions). */
export const COOKIES = {
  /** JWT d'accès — httpOnly, jamais lisible en JavaScript. */
  ACCESS: 'ws_access',
  /** Refresh token — httpOnly, limité au chemin de rafraîchissement. */
  REFRESH: 'ws_refresh',
  /** Jeton CSRF — lisible par le front (double-submit), donc PAS httpOnly. */
  CSRF: 'ws_csrf',
  /** Étiquette de rôle pour l'affichage — non httpOnly, jamais source de vérité. */
  ROLE: 'ws_role',
} as const;

/** Chemin du refresh : le cookie n'est jamais transmis aux autres endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

/** En-tête portant le second exemplaire du jeton CSRF. */
export const CSRF_HEADER = 'x-csrf-token';

/** Préfixe global des routes de l'API. */
export const API_PREFIX = 'api/v1';

/** Méthodes HTTP sans effet de bord — exemptées de la vérification CSRF. */
export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];
