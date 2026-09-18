import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'skipCsrf';

/**
 * Exempte une route du contrôle CSRF.
 *
 * Réservé aux routes qui ÉTABLISSENT une session (login, refresh) : à ce stade
 * aucun cookie CSRF n'existe encore côté client, la garde n'aurait rien à comparer.
 * Ne jamais poser ce décorateur sur une mutation de données.
 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
