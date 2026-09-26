import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  provideZonelessChangeDetection,
  type ApplicationConfig,
  type EnvironmentProviders,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
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
    // `anchorScrolling` fait atteindre un titre par son ancre : sans lui, un
    // lien profond change l'URL sans bouger la page, et le sommaire interne du
    // portail d'aide ne mènerait nulle part.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ anchorScrolling: 'enabled' }),
    ),
    provideHttpClient(withInterceptors([credentialsInterceptor, csrfInterceptor, authInterceptor])),
    provideSessionBootstrap(),
  ],
};
