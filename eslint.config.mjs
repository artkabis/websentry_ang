import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Configuration ESLint partagée du monorepo.
 *
 * Les règles typées (`recommendedTypeChecked`) sont activées : elles détectent ce
 * qu'une analyse syntaxique seule ne peut pas voir — une promesse non attendue,
 * un `any` qui se propage — précisément les défauts qui se manifestent en
 * production plutôt qu'au build.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.angular/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  // ── Backend Nest + package partagé ────────────────────────────────────────
  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Les décorateurs Nest exigent des classes avec constructeur injecté : la
      // règle « pas de classe purement statique » n'a pas de sens ici.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Une promesse ignorée dans un garde ou un intercepteur laisse passer une
      // erreur silencieusement : on l'interdit, `void` marque l'intention.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  // ── Frontend Angular ──────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'ws', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'ws', style: 'kebab-case' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Les validateurs Angular (`Validators.required`…) sont conçus pour être
      // passés par référence : la règle les signale à tort sur chaque formulaire.
      '@typescript-eslint/unbound-method': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  // ── Templates Angular ─────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },

  // ── Scénarios Playwright ──────────────────────────────────────────────────
  // Analysés contre leur propre tsconfig : ils s'exécutent dans Node et pilotent
  // un navigateur, sans les types Vitest ni le DOM de l'application.
  {
    files: ['apps/web/e2e/**/*.ts', 'apps/web/playwright.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Fichiers de test ──────────────────────────────────────────────────────
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts', '**/testing/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Les doubles de test manipulent volontairement des formes partielles :
      // exiger un typage exhaustif rendrait les tests illisibles sans rien
      // prouver de plus.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Prettier en dernier : neutralise les règles de mise en forme concurrentes.
  prettier,
);
