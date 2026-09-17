import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Suite unitaire du backend.
 *
 * Vitest plutôt que Jest : Nest 12 n'est distribué qu'en ESM, et la chaîne
 * Jest+ts-jest en ESM reste expérimentale (drapeaux VM Node, mocks partiels).
 * Vitest est nativement ESM et partage son moteur avec le reste de l'outillage
 * Vite du parc (cf. docs/DECISIONS.md, arbitrage n°3).
 *
 * La transformation passe par SWC et NON par esbuild : esbuild n'implémente pas
 * `emitDecoratorMetadata`, dont dépend l'injection par type de Nest. Sans lui, tout
 * `constructor(private readonly x: Service)` recevrait `undefined`.
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
    include: ['src/**/*.spec.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.module.ts',
        'src/**/index.ts',
        'src/main.ts',
        'src/bootstrap.ts', // couvert de bout en bout par la suite E2E
      ],
      // Seuils BLOQUANTS : sous le seuil, la commande sort en code non nul et
      // la CI s'arrête (cf. .github/workflows/ci.yml).
      thresholds: {
        // Plancher global du backend.
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
        // Modules de SÉCURITÉ — 100 % exigés.
        'src/security/ip-rules.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/security/password.service.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/security/csrf.guard.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/auth/token.service.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/auth/guards/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/rbac/rbac.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
});
