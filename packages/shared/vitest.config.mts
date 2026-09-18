import { defineConfig } from 'vitest/config';

/**
 * Tests du paquet partagé.
 *
 * Ce paquet n'est pas qu'un sac de types : il porte le schéma de validation qui
 * garde la frontière HTTP (bornes, intervalles cohérents, refus des clés de
 * pollution de prototype) et la hiérarchie RBAC. Ces règles méritent donc leurs
 * propres tests, au plus près de leur définition.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/index.ts',
        // Données pures : un registre de constantes, sans branche à couvrir.
        'src/analyzers-registry.ts',
      ],
      // Seuils BLOQUANTS — ce paquet garde la frontière de validation.
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
