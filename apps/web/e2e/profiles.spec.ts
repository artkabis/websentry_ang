import { expect, test, type Page } from '@playwright/test';

/**
 * Parcours profils, vérifié dans un vrai navigateur.
 *
 * L'API est simulée au niveau du réseau : ces scénarios valident l'enchaînement
 * côté interface — droits, verrouillage optimiste, contrôles croisés — sans
 * dépendre d'une base de données. Le contrat de l'API est couvert, lui, par la
 * suite Supertest côté backend.
 */

const REGLAGES = {
  meta: { title: { min: 50, max: 65 }, description: { min: 140, max: 156 } },
  hn: { minLength: 50, maxLength: 90, excludedWords: ['le', 'la'] },
  bold: { min: 3, max: 5, minParentWords: 20 },
  images: { maxSizeBytes: 317435, warningThresholdBytes: 256000, maxRatio: 3 },
  links: { timeout: 10000, excludedDomains: ['mappy.com'] },
  content: { minWords: 300, warningWords: 500 },
  enabledChecks: ['METAS', 'LOGO'],
};

function profil(over: Record<string, unknown> = {}) {
  return {
    profile: 'premium',
    label: 'Premium',
    description: null,
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'alice',
    settings: REGLAGES,
    ...over,
  };
}

const REGISTRE = {
  checks: [
    { id: 'METAS', title: 'Métadonnées', group: 'SEO' },
    { id: 'LOGO', title: 'Logo', group: 'Design' },
  ],
  subChecks: [],
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Simule une session dont le rang détermine les droits d'édition. */
async function connecte(page: Page, rank: number) {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        rank,
        role: rank >= 50 ? 'admin' : 'tester',
        status: 'active',
        permissions: [],
      }),
    ),
  );
  await page.route('**/api/v1/registry', route => route.fulfill(json(REGISTRE)));
}

test.describe('Liste des profils', () => {
  test('affiche les profils et signale le repli', async ({ page }) => {
    await connecte(page, 50);
    await page.route('**/api/v1/profiles', route =>
      route.fulfill(
        json([
          { ...profil({ profile: 'default', label: 'Défaut' }), settings: undefined },
          { ...profil(), settings: undefined },
        ]),
      ),
    );

    await page.goto('/profils');

    await expect(page.getByRole('heading', { name: 'Profils par gamme' })).toBeVisible();
    await expect(page.getByText('Défaut')).toBeVisible();
    await expect(page.getByText('Repli')).toBeVisible();
  });

  test('MASQUE la création à un testeur', async ({ page }) => {
    await connecte(page, 10);
    await page.route('**/api/v1/profiles', route => route.fulfill(json([])));

    await page.goto('/profils');
    await expect(page.getByRole('heading', { name: 'Profils par gamme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nouveau profil' })).toBeHidden();
  });
});

test.describe('Éditeur de profil', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/profiles/premium', route => {
      if (route.request().method() === 'GET') return route.fulfill(json(profil()));
      return route.fallback();
    });
  });

  test('alimente le formulaire depuis le profil chargé', async ({ page }) => {
    await connecte(page, 50);
    await page.goto('/profils/premium');

    await expect(page.getByLabel('Titre — minimum')).toHaveValue('50');
    await expect(page.getByLabel('Mots — minimum')).toHaveValue('300');
    await expect(page.getByText(/version 3/)).toBeVisible();
  });

  test('passe en CONSULTATION SEULE pour un testeur', async ({ page }) => {
    await connecte(page, 10);
    await page.goto('/profils/premium');

    await expect(page.getByText(/Consultation seule/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeHidden();
  });

  test('TRANSMET la version lue à l’enregistrement', async ({ page }) => {
    await connecte(page, 50);
    let versionSoumise: unknown;

    await page.route('**/api/v1/profiles/premium', async route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      versionSoumise = (route.request().postDataJSON() as { expectedVersion?: number })
        .expectedVersion;
      return route.fulfill(json(profil({ version: 4 })));
    });

    await page.goto('/profils/premium');
    await page.getByRole('button', { name: 'Enregistrer' }).click();

    await expect(page.getByRole('status')).toContainText('Profil enregistré');
    expect(versionSoumise).toBe(3);
  });

  test('PROPOSE un rechargement sur conflit de version', async ({ page }) => {
    await connecte(page, 50);
    await page.route('**/api/v1/profiles/premium', async route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      return route.fulfill(
        json(
          {
            statusCode: 409,
            error: 'Conflit de version',
            message: 'Modifié entre-temps',
            details: { currentVersion: 9, expectedVersion: 3 },
          },
          409,
        ),
      );
    });

    await page.goto('/profils/premium');
    await page.getByRole('button', { name: 'Enregistrer' }).click();

    const alerte = page.getByRole('alert');
    await expect(alerte).toContainText('modifié par quelqu');
    await expect(alerte).toContainText('9');
    await expect(page.getByRole('button', { name: 'Recharger le profil' })).toBeVisible();
  });

  test('BLOQUE un intervalle inversé — le bouton devient inactif', async ({ page }) => {
    await connecte(page, 50);
    await page.goto('/profils/premium');

    const enregistrer = page.getByRole('button', { name: 'Enregistrer' });
    await expect(enregistrer).toBeEnabled();

    await page.getByLabel('Titre — minimum').fill('900');

    // L'incohérence est signalée ET la soumission rendue impossible : l'API
    // n'est pas sollicitée pour rien, et l'utilisateur sait pourquoi.
    await expect(page.getByText(/Intervalle titre inversé/)).toBeVisible();
    await expect(enregistrer).toBeDisabled();
  });

  test('ouvre sur les valeurs par défaut pour une gamme inexistante', async ({ page }) => {
    await connecte(page, 50);
    await page.route('**/api/v1/profiles/nouvelle', route =>
      route.fulfill(json({ statusCode: 404, error: 'Not Found', message: 'Introuvable' }, 404)),
    );

    await page.goto('/profils/nouvelle');

    await expect(page.getByText(/nouveau profil/)).toBeVisible();
    await expect(page.getByLabel('Mots — minimum')).toHaveValue('300');
  });
});
