/**
 * Lecture du jeton CSRF déposé par l'API.
 *
 * Le cookie `ws_csrf` est volontairement NON httpOnly : le double-submit exige
 * que le front le relise pour le renvoyer en en-tête. Les jetons d'accès, eux,
 * restent httpOnly et invisibles d'ici — c'est toute la différence.
 */
export const CSRF_COOKIE = 'ws_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

/** Cookie de rôle — étiquette d'affichage uniquement, jamais une autorisation. */
export const ROLE_COOKIE = 'ws_role';

/**
 * Lit un cookie par son nom.
 *
 * @returns sa valeur décodée, ou `null` s'il est absent.
 */
export function readCookie(name: string, source: string = document.cookie): string | null {
  for (const part of source.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return null;
}

/** Méthodes HTTP sans effet de bord — aucun jeton CSRF à joindre. */
export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];
