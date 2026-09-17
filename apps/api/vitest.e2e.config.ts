import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Suites E2E et sécurité — montent l'application Nest COMPLÈTE (adapter Fastify,
 * helmet, cookies, gardes globales) et la sollicitent par HTTP réel via Supertest.
 *
 * `singleThread` : les suites partagent des compteurs en mémoire (limiteur de
 * connexion, cache SSRF). Les exécuter en parallèle rendrait les assertions de
 * rate-limiting non déterministes.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/helpers/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    // Exécution SÉRIELLE : les suites partagent des compteurs en mémoire
    // (limiteur de connexion, cache SSRF). En parallèle, les assertions de
    // limitation de débit deviendraient non déterministes.
    fileParallelism: false,
  },
});
