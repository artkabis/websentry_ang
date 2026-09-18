import type { HttpInterceptorFn } from '@angular/common/http';
import { CSRF_COOKIE, CSRF_HEADER, readCookie, SAFE_METHODS } from './csrf';

/**
 * Joint le jeton CSRF à chaque mutation.
 *
 * Le serveur compare cet en-tête au cookie `ws_csrf`. Un site tiers peut faire
 * partir une requête avec les cookies de la victime, mais la politique d'origine
 * identique l'empêche de LIRE ce cookie — il ne peut donc pas reconstituer
 * l'en-tête, et la requête est rejetée côté serveur.
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  if (SAFE_METHODS.includes(req.method)) return next(req);

  const token = readCookie(CSRF_COOKIE);
  if (!token) return next(req);

  return next(req.clone({ setHeaders: { [CSRF_HEADER]: token } }));
};
