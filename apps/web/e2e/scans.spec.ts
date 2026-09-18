import { expect, test, type Page } from '@playwright/test';

/**
 * Parcours historique des scans, vérifié dans un vrai navigateur.
 *
 * L'API est simulée au niveau du réseau : ces scénarios valident l'enchaînement
 * côté interface — reflet des filtres dans l'URL, tri, comparaison de deux
 * audits — sans dépendre d'une base. Le contrat de l'API est vérifié par la
 * suite Supertest côté backend.
 */

const ME = {
  id: 'u1',
  username: 'alice',
  rank: 50,
  role: 'admin',
  status: 'active',
  permissions: [],
};

const SITE = {
  siteId: '44444444-4444-4444-8444-444444444444',
  domain: 'exemple.fr',
  gamme: 'premium',
  epj: 'ABC-123',
  lastSessionId: '11111111-1111-4111-8111-111111111111',
  pageCount: 12,
  avgScore: 4.2,
  minScore: 3,
  maxScore: 5,
  lastScan: '2026-06-04T10:00:00.000Z',
  sessionCount: 2,
  launchedBy: 'alice',
  metadata: null,
};

const SESSIONS = [
  {
    sessionId: '11111111-1111-4111-8111-111111111111',
    pageCount: 3,
    avgScore: 2,
    minScore: 1,
    maxScore: 3,
    analyzedAt: '2026-06-10T10:00:00.000Z',
    durationMs: 3000,
    launchedBy: 'alice',
  },
  {
    sessionId: '22222222-2222-4222-8222-222222222222',
    pageCount: 3,
    avgScore: 4,
    minScore: 3,
    maxScore: 5,
    analyzedAt: '2026-06-01T10:00:00.000Z',
    durationMs: 4000,
    launchedBy: 'bob',
  },
];

const COMPARISON = {
  base: {
    sessionId: '22222222-2222-4222-8222-222222222222',
    analyzedAt: '2026-06-01T10:00:00.000Z',
    avgScore: 4,
    pageCount: 3,
  },
  target: {
    sessionId: '11111111-1111-4111-8111-111111111111',
    analyzedAt: '2026-06-10T10:00:00.000Z',
    avgScore: 2,
    pageCount: 3,
  },
  scoreDelta: -2,
  summary: { added: 0, removed: 1, degraded: 1, improved: 0, unchanged: 0 },
  pages: [
    {
      url: 'https://exemple.fr/',
      change: 'changed',
      baseScore: 4,
      targetScore: 2,
      scoreDelta: -2,
      degraded: 1,
      improved: 0,
      checks: [{ checkId: 'METAS', baseStatus: 'pass', targetStatus: 'fail', trend: 'degraded' }],
    },
  ],
};

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(page: Page, options: { sites?: unknown[] } = {}): Promise<void> {
  await page.route('**/api/v1/auth/me', route => route.fulfill(json(ME)));

  await page.route('**/api/v1/scans/sites/sessions*', route => route.fulfill(json(SESSIONS)));

  await page.route('**/api/v1/scans/sites*', route => {
    const sites = options.sites ?? [SITE];
    return route.fulfill(
      json({ total: sites.length, page: 1, limit: 20, pages: sites.length ? 1 : 0, sites }),
    );
  });

  await page.route('**/api/v1/scans/sessions/*/compare/*', route =>
    route.fulfill(json(COMPARISON)),
  );
}

test.describe('Historique des scans', () => {
  test('liste les sites audités', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique');

    await expect(page.getByRole('heading', { name: 'Historique des scans' })).toBeVisible();
    await expect(page.getByRole('link', { name: /exemple\.fr/ })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('1 site(s)');
  });

  test('REFLÈTE les filtres dans l’URL, qui devient partageable', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique');

    await page.getByLabel('Recherche').fill('exemple');
    await page.getByRole('button', { name: 'Filtrer' }).click();

    await expect(page).toHaveURL(/[?&]q=exemple/);
  });

  test('REJOUE une recherche partagée à l’identique', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique?q=exemple&gamme=premium');

    // Les champs sont pré-remplis depuis l'adresse : le destinataire du lien
    // voit la même recherche que son expéditeur.
    await expect(page.getByLabel('Recherche')).toHaveValue('exemple');
    await expect(page.getByLabel('Gamme', { exact: true })).toHaveValue('premium');
  });

  test('trie par colonne et l’annonce aux technologies d’assistance', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique');

    await page.getByRole('button', { name: /Score moyen/ }).click();

    await expect(page).toHaveURL(/[?&]sort=score/);
    await expect(page.getByRole('columnheader', { name: /Score moyen/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  test('GUIDE l’utilisateur quand aucun site ne correspond', async ({ page }) => {
    await mockApi(page, { sites: [] });
    await page.goto('/historique?domain=introuvable');

    await expect(page.getByText(/Aucun site ne correspond à ces filtres/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Effacer les filtres/ })).toBeVisible();
  });

  test('ouvre l’historique d’un site', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique');

    await page.getByRole('link', { name: /exemple\.fr/ }).click();

    await expect(page).toHaveURL(/\/historique\/site\?domain=exemple\.fr/);
    await expect(page.getByRole('heading', { name: 'exemple.fr' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('2 audit(s)');
  });

  test('compare deux audits', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique/site?domain=exemple.fr&gamme=premium');

    const boxes = page.getByRole('checkbox');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole('button', { name: 'Comparer' }).click();

    await expect(page.getByRole('heading', { name: /Évolution entre deux audits/ })).toBeVisible();
    await expect(page.getByText(/score moyen −2,0/)).toBeVisible();
    await expect(page.getByText('METAS : pass → fail')).toBeVisible();
  });

  test('BLOQUE la comparaison tant qu’un seul audit est retenu', async ({ page }) => {
    await mockApi(page);
    await page.goto('/historique/site?domain=exemple.fr&gamme=premium');

    const compare = page.getByRole('button', { name: 'Comparer' });
    await expect(compare).toBeDisabled();

    await page.getByRole('checkbox').first().check();
    await expect(compare).toBeDisabled();
    await expect(page.getByText('Sélectionnez un second audit.')).toBeVisible();
  });

  test('navigue au clavier de bout en bout', async ({ page }) => {
    // Tout ce qui est actionnable doit l'être sans souris (WCAG 2.1.1).
    await mockApi(page);
    await page.goto('/historique/site?domain=exemple.fr&gamme=premium');

    await page.getByRole('checkbox').first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');

    await expect(page.getByText('Deux audits sélectionnés.')).toBeVisible();
  });
});
