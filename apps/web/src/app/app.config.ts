import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  provideZonelessChangeDetection,
  type ApplicationConfig,
  type EnvironmentProviders,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { credentialsInterceptor } from './core/auth/credentials.interceptor';
import { csrfInterceptor } from './core/auth/csrf.interceptor';
import { AuthService } from './core/auth/auth.service';

/**
 * Résolution de la session au démarrage.
 *
 * Les cookies d'authentification sont httpOnly : le front ne peut pas savoir s'il
 * est connecté sans interroger `/auth/me`. Cet initialiseur pose donc l'état
 * avant le premier rendu, ce qui évite un aller-retour visible par l'écran de
 * connexion.
 */
function provideSessionBootstrap(): EnvironmentProviders {
  return provideAppInitializer(() => inject(AuthService).refreshProfile());
}

/**
 * ORDRE des intercepteurs — significatif, Angular les applique en séquence :
 *   1. credentials — attache les cookies aux requêtes destinées à l'API ;
 *   2. csrf        — joint le jeton aux mutations ;
 *   3. auth        — rattrape les 401 et tente une rotation, donc en dernier, sur
 *                    une requête déjà complète à rejouer telle quelle.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([credentialsInterceptor, csrfInterceptor, authInterceptor])),
    provideTanStackQuery(
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Une erreur 401/403 ne se résout pas en réessayant : seules les
            // pannes transitoires méritent une nouvelle tentative.
            retry: (failureCount, error) => {
              const status = (error as { status?: number })?.status;
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
          },
        },
      }),
    ),
    provideSessionBootstrap(),
  ],
};
