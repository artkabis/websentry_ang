import { expect, test, type Page } from '@playwright/test';

/**
 * Parcours d'analyse, vérifié dans un vrai navigateur.
 *
 * Le flux SSE est simulé au niveau du réseau : ces scénarios valident les trois
 * niveaux de lecture — verdict, critères filtrés, détail — et la navigation au
 * clavier. Le contrat de l'API est vérifié par la suite Supertest côté backend.
 */

const ME = {
  id: 'u1',
  username: 'alice',
  rank: 50,
  role: 'admin',
  status: 'active',
  permissions: [],
};

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

function check(checkId: string, checkTitle: string, status: string, over: object = {}) {
  return {
    checkId,
    checkTitle,
    globalScore: status === 'fail' ? 1 : 5,
    status,
    items: [],
    summary: `Résumé ${checkTitle}`,
    recommendations: [`Corriger ${checkTitle}`],
    ...over,
  };
}

const CHECKS = [
  check('METAS', 'Balises méta', 'fail', {
    items: [
      { label: 'Title manquant', status: 'fail', locator: { text: 'Accueil' } },
      { label: 'Description présente', status: 'pass' },
    ],
    recommendations: ['Ajouter une balise <title> unique et descriptive.'],
  }),
  check('HN_STRUCTURE', 'Hiérarchie des titres', 'warning'),
  check('CANONICAL', 'Balise canonical', 'pass'),
  check('LANG', 'Langue de la page', 'pass'),
];

const REPORT = {
  analyzeId: ANALYZE_ID,
  url: 'https://exemple.fr/',
  title: 'Accueil',
  analyzedAt: '2026-06-04T10:00:00.000Z',
  durationMs: 1200,
  globalScore: 2.4,
  platform: 'generic',
  renderMode: 'static',
  statusCode: 200,
  ttfb: 100,
  redirectChain: [],
  htmlSize: 4200,
  httpHeaders: { 'content-type': 'text/html' },
  dudaParams: null,
  checks: Object.fromEntries(CHECKS.map(item => [item.checkId, item])),
};

/** Compose un corps SSE à partir d'une suite d'événements. */
function sseBody(events: readonly object[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const FULL_RUN = sseBody([
  { type: 'start', analyzeId: ANALYZE_ID, url: 'https://exemple.fr/', total: CHECKS.length },
  ...CHECKS.map((result, index) => ({
    type: 'check',
    analyzeId: ANALYZE_ID,
    completed: index + 1,
    total: CHECKS.length,
    result,
  })),
  { type: 'complete', analyzeId: ANALYZE_ID, report: REPORT },
]);

async function mockApi(page: Page, body: string = FULL_RUN): Promise<void> {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
  await page.route('**/api/v1/analyze/stream', route =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }),
  );
}

async function runAnalysis(page: Page): Promise<void> {
  await page.goto('/analyse');
  await page.getByRole('textbox').fill('https://exemple.fr/');
  await page.getByRole('button', { name: 'Analyser' }).click();
}

test.describe('Analyse d’une page', () => {
  test('affiche le verdict et le score', async ({ page }) => {
    await mockApi(page);
    await runAnalysis(page);

    await expect(page.getByRole('heading', { name: 'Corrections urgentes' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Score 2,4 sur 5/ })).toBeVisible();
  });

  test('PLACE les corrections prioritaires avant le détail', async ({ page }) => {
    // C'est ce qu'on lit quand on n'a que trente secondes.
    await mockApi(page);
    await runAnalysis(page);

    await expect(page.getByRole('heading', { name: 'À corriger en priorité' })).toBeVisible();
    await expect(page.getByText('Ajouter une balise <title> unique et descriptive.')).toBeVisible();
  });

  test('N’AFFICHE par défaut que les critères à traiter', async ({ page }) => {
    // Le choix central du remaniement : un rapport qui s'ouvre sur les
    // problèmes se lit, un rapport qui s'ouvre sur les réussites se survole.
    await mockApi(page);
    await runAnalysis(page);

    await expect(page.getByRole('button', { name: /Balises méta/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Balise canonical/ })).toBeHidden();
    await expect(
      page.getByText(/2 critère\(s\) conforme\(s\) ou non applicable\(s\) masqué/),
    ).toBeVisible();
  });

  test('révèle le rapport complet à la demande', async ({ page }) => {
    await mockApi(page);
    await runAnalysis(page);

    await page.getByRole('button', { name: /^Tout/ }).click();
    await expect(page.getByRole('button', { name: /Balise canonical/ })).toBeVisible();
  });

  test('ouvre le détail d’un critère et montre quoi faire', async ({ page }) => {
    await mockApi(page);
    await runAnalysis(page);

    const toggle = page.getByRole('button', { name: /Balises méta/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Que faire')).toBeVisible();
    await expect(page.getByText('Title manquant')).toBeVisible();
  });

  test('propose d’ouvrir la page sur l’élément fautif', async ({ page }) => {
    await mockApi(page);
    await runAnalysis(page);
    await page.getByRole('button', { name: /Balises méta/ }).click();

    const link = page.getByRole('link', { name: 'Voir dans la page' });
    await expect(link).toHaveAttribute('href', /#:~:text=Accueil/);
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('parcourt le rapport ENTIÈREMENT au clavier', async ({ page }) => {
    // Tout ce qui est actionnable doit l'être sans souris (WCAG 2.1.1).
    await mockApi(page);
    await runAnalysis(page);

    const toggle = page.getByRole('button', { name: /Balises méta/ });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('signale une erreur d’analyse et propose de réessayer', async ({ page }) => {
    await mockApi(
      page,
      sseBody([
        {
          type: 'error',
          analyzeId: null,
          message: 'Cette URL ne peut pas être analysée : elle cible une adresse non publique.',
        },
      ]),
    );
    await runAnalysis(page);

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('adresse non publique');
    await expect(alert.getByRole('button', { name: 'Réessayer' })).toBeVisible();
  });

  test('renvoie vers l’historique une fois l’analyse enregistrée', async ({ page }) => {
    await mockApi(page);
    await runAnalysis(page);

    await expect(
      page.getByRole('link', { name: /retrouver ce scan dans l'historique/ }),
    ).toBeVisible();
  });
});
