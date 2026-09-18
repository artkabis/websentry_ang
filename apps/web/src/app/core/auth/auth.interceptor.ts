import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { API_BASE_URL } from '../api/api.config';
import { AuthService } from './auth.service';

/** Routes d'authentification à ne PAS rejouer : elles produisent le 401 elles-mêmes. */
const NO_RETRY = ['/auth/login', '/auth/refresh', '/auth/logout'];

/**
 * Renouvellement silencieux de session.
 *
 * Sur 401, tente UNE rotation du refresh token puis rejoue la requête. L'access
 * token vit 15 minutes : sans ce mécanisme, l'utilisateur serait déconnecté
 * toutes les quinze minutes en pleine saisie.
 *
 * Deux garde-fous :
 *   • les routes d'authentification sont exclues — les rejouer boucle ;
 *   • une seule tentative par requête, et une rotation partagée entre requêtes
 *     concurrentes, sinon dix appels simultanés déclencheraient dix rotations,
 *     dont neuf invalideraient le jeton obtenu par la première.
 */
let inFlightRefresh: Promise<boolean> | null = null;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const baseUrl = inject(API_BASE_URL);

  const isAuthRoute = NO_RETRY.some(path => req.url.startsWith(`${baseUrl}${path}`));

  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || isAuthRoute) {
        return throwError(() => err);
      }

      inFlightRefresh ??= auth.refreshSession().finally(() => {
        inFlightRefresh = null;
      });

      return from(inFlightRefresh).pipe(
        switchMap(renewed => {
          if (!renewed) {
            void router.navigate(['/connexion'], {
              queryParams: { retour: router.url },
            });
            return throwError(() => err);
          }
          // Le nouveau cookie est déjà posé : il suffit de rejouer la requête.
          return next(req);
        }),
      );
    }),
  );
};

/** Réinitialise la rotation en cours — réservé aux tests. */
export function resetInFlightRefresh(): void {
  inFlightRefresh = null;
}
