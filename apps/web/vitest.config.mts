import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vitest/config';

/**
 * Suite de tests du frontend.
 *
 * Vitest + Angular Testing Library plutôt que Karma/Jasmine : Karma est déprécié
 * depuis Angular 16, et Vitest partage son moteur avec l'outillage Vite du reste
 * du parc (cf. docs/DECISIONS.md, arbitrage n°3). Testing Library oriente les
 * tests vers ce que l'utilisateur voit — rôles, libellés — plutôt que vers la
 * structure interne des composants, qui change à chaque refonte.
 */
export default defineConfig({
  plugins: [angular()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/testing/setup.ts'],
    include: ['src/**/*.spec.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/app/**/*.ts'],
      exclude: [
        'src/app/**/*.spec.ts',
        'src/app/app.routes.ts', // table de routage déclarative
        'src/app/app.config.ts', // câblage de providers, couvert par les E2E
        'src/app/core/auth/auth.models.ts', // déclarations de types
      ],
      // Seuils BLOQUANTS — 80 % sur les composants et services.
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
  define: {
    // Le compilateur Angular s'attend à ces drapeaux au moment du bundling.
    'import.meta.vitest': 'undefined',
  },
});
