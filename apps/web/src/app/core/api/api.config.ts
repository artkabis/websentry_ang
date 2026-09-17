import { InjectionToken } from '@angular/core';

/**
 * URL de base de l'API.
 *
 * Fournie par injection plutôt que codée en dur : les tests la remplacent, et le
 * déploiement la pose depuis l'environnement au démarrage.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api/v1',
});
