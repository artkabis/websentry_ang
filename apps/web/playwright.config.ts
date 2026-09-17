import { defineConfig, devices } from '@playwright/test';

/**
 * Scénarios E2E navigateur.
 *
 * Playwright plutôt que Cypress : exécution hors du contexte de la page (donc
 * pas de contraintes d'origine), attente automatique, et pilotage natif des
 * cookies — indispensable ici, puisque toute l'authentification repose sur des
 * cookies httpOnly qu'un test exécuté DANS la page ne pourrait pas inspecter.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Interdit un `test.only` oublié d'atteindre la branche principale.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Permet d'utiliser un Chromium DÉJÀ présent (image de conteneur,
        // runner hors ligne) au lieu de le télécharger. Sans cette variable,
        // Playwright utilise le navigateur qu'il a lui-même installé.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],

  // Le serveur de développement est démarré par Playwright lui-même : aucun
  // enchaînement manuel à tenir dans la CI.
  webServer: {
    command: 'pnpm exec ng serve --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
