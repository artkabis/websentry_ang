import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Le travail de fond de rétention reste DÉSACTIVÉ pendant les tests.
 *
 * Il se déclencherait au démarrage de chaque application montée par la
 * fabrique, écrirait dans le double de base pendant qu'un test l'inspecte, et
 * laisserait un minuteur derrière lui. Sa logique est couverte par ses propres
 * tests unitaires, où elle est pilotée explicitement.
 */
process.env.SCAN_RETENTION_ENABLED = 'false';

/**
 * Les pièces jointes de la messagerie sont rangées dans un dossier TEMPORAIRE.
 *
 * Sans cela, la suite écrirait dans `./data/pieces-jointes` du dépôt, et y
 * laisserait ses fichiers d'un passage à l'autre.
 */
process.env.MESSAGE_UPLOADS_DIR = join(tmpdir(), `websentry-pj-test-${process.pid}`);
