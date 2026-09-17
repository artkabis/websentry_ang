import { expect, test } from '@playwright/test';

/**
 * Parcours critiques, vérifiés dans un vrai navigateur.
 *
 * L'API est SIMULÉE au niveau du réseau (`page.route`) : ces scénarios valident
 * l'enchaînement côté interface — redirections, gardes, rendu — sans dépendre
 * d'une base de données ni d'un backend en cours d'exécution. Le contrat de
 * l'API, lui, est vérifié par la suite E2E Supertest côté backend.
 */

const ME = {
  id: 'u1',
  username: 'alice',
  rank: 50,
  role: 'admin',
  status: 'active',
  permissions: [{ permission: 'docs:read', gammes: null }],
};

/** Simule une session établie : `/auth/me` répond, les autres routes suivent. */
async function mockAuthenticated(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
}

/** Simule l'absence de session. */
async function mockAnonymous(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 401, error: 'Unauthorized', message: 'Non authentifié' }),
    }),
  );
}

test.describe('Parcours de connexion', () => {
  test('redirige un visiteur non authentifié vers la connexion', async ({ page }) => {
    await mockAnonymous(page);
    await page.goto('/tableau-de-bord');

    await expect(page).toHaveURL(/\/connexion/);
    await expect(page.getByRole('heading', { name: 'WebSentry' })).toBeVisible();
  });

  test('affiche une erreur sur identifiants invalides', async ({ page }) => {
    await mockAnonymous(page);
    await page.route('**/api/v1/auth/login', route =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Identifiants incorrects',
        }),
      }),
    );

    await page.goto('/connexion');
    await page.getByLabel('Identifiant').fill('alice');
    await page.getByLabel('Mot de passe').fill('mauvais');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    await expect(page.getByRole('alert')).toContainText('Identifiants incorrects');
    // L'utilisateur reste sur l'écran de connexion.
    await expect(page).toHaveURL(/\/connexion/);
    // Le mot de passe est effacé, l'identifiant conservé.
    await expect(page.getByLabel('Mot de passe')).toHaveValue('');
    await expect(page.getByLabel('Identifiant')).toHaveValue('alice');
  });

  test('connecte puis affiche le tableau de bord', async ({ page }) => {
    await mockAnonymous(page);
    await page.goto('/connexion');

    // La session bascule au moment du login.
    await page.route('**/api/v1/auth/login', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ role: 'admin', username: 'alice' }),
      }),
    );
    await mockAuthenticated(page);

    await page.getByLabel('Identifiant').fill('alice');
    await page.getByLabel('Mot de passe').fill('MonMotDePasse');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    await expect(page).toHaveURL(/\/tableau-de-bord/);
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await expect(page.getByText('alice')).toBeVisible();
  });

  test('refuse un formulaire vide SANS appeler l’API', async ({ page }) => {
    await mockAnonymous(page);

    let apiCalled = false;
    await page.route('**/api/v1/auth/login', route => {
      apiCalled = true;
      return route.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/connexion');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    await expect(page.getByText(/L'identifiant est requis/)).toBeVisible();
    expect(apiCalled).toBe(false);
  });
});

test.describe('Navigation selon le rôle', () => {
  test('affiche la section d’administration à un admin', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');

    await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  });

  test('MASQUE la section d’administration à un tester', async ({ page }) => {
    await page.route('**/api/v1/auth/me', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...ME, rank: 10, role: 'tester', permissions: [] }),
      }),
    );

    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administration' })).toBeHidden();
  });

  test('renvoie au tableau de bord un utilisateur déjà connecté qui vise /connexion', async ({
    page,
  }) => {
    await mockAuthenticated(page);
    await page.goto('/connexion');

    await expect(page).toHaveURL(/\/tableau-de-bord/);
  });

  test('déconnecte et ramène à l’écran de connexion', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();

    await page.route('**/api/v1/auth/logout', route => route.fulfill({ status: 204, body: '' }));
    await page.getByRole('button', { name: 'Se déconnecter' }).click();

    await expect(page).toHaveURL(/\/connexion/);
  });
});

test.describe('Jetons inaccessibles au JavaScript', () => {
  test('ne laisse aucun jeton lisible depuis la page', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');

    // Les cookies d'accès et de rafraîchissement sont httpOnly : même un script
    // injecté ne pourrait pas les lire.
    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain('ws_access');
    expect(visibleCookies).not.toContain('ws_refresh');

    // Aucun jeton stocké côté navigateur non plus.
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]+\./); // motif d'un JWT
  });
});
