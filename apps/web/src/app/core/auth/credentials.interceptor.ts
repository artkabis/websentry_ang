import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { API_BASE_URL } from '../api/api.config';

/**
 * Active l'envoi des cookies vers l'API.
 *
 * `withCredentials` est posé UNIQUEMENT sur les requêtes destinées à notre API :
 * l'activer globalement enverrait les cookies d'authentification à toute origine
 * contactée par l'application.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(API_BASE_URL);
  const targetsApi = req.url.startsWith(baseUrl) || req.url.startsWith('/api/');

  return next(targetsApi ? req.clone({ withCredentials: true }) : req);
};
