import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Rend une route accessible sans authentification.
 *
 * Le garde JWT est appliqué GLOBALEMENT : une route est protégée par défaut et
 * ne s'ouvre que par ce décorateur explicite. Oublier une garde ne peut donc pas
 * exposer un endpoint par accident.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
