/**
 * Variables d'environnement de test.
 *
 * Chargé via `setupFiles` : la validation Zod de `AppConfigModule` s'exécute au
 * chargement du module, donc AVANT le corps des tests. Les poser dans une
 * fonction de fabrique arriverait trop tard.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'secret-de-test-hs256-suffisamment-long-ok';
process.env.DB_ENABLED = 'true';
process.env.CORS_ORIGIN = 'http://localhost:4200';
process.env.ACCESS_TOKEN_TTL = '900';
process.env.REFRESH_TOKEN_TTL = '604800';
process.env.LOGIN_MAX_ATTEMPTS = '5';
process.env.LOGIN_LOCKOUT_SECONDS = '900';
process.env.LOG_LEVEL = 'error';
