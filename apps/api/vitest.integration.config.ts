import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Suites d'INTÉGRATION — le seul endroit du projet où le SQL rencontre un vrai
 * moteur MariaDB.
 *
 * Elles sont séparées parce qu'elles ont un prérequis que les autres n'ont pas :
 * une base accessible. Les mêler à `pnpm test` rendrait la suite unitaire
 * dépendante d'un service, et la première machine sans base transformerait un
 * échec d'environnement en échec de code.
 *
 * `fileParallelism: false` : chaque fichier vide les tables. En parallèle, un
 * fichier effacerait les lignes qu'un autre vient d'insérer.
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
    include: ['test/integration/**/*.integration-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    clearMocks: true,
    restoreMocks: true,
    fileParallelism: false,
  },
});
