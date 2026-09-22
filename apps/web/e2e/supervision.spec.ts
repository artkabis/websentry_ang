import { expect, test, type Page } from '@playwright/test';

/**
 * Supervision, vérifiée dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne prouvent pas : la garde de route réelle, et le
 * fait qu'un échec de rafraîchissement laisse le relevé précédent à l'écran.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function releve(over: Record<string, unknown> = {}) {
  return {
    etat: 'ok',
    releveA: '2026-01-01T10:00:00.000Z',
    instance: { version: '2.0.0', environnement: 'production', uptimeSec: 90_000 },
    base: { etat: 'ok', message: 'Connectée, 3 ms.', active: true, latenceMs: 3 },
    poolAnalyse: {
      etat: 'ok',
      message: 'Pool démarré — 4 thread(s).',
      active: true,
      demarre: true,
      enEchec: false,
      threadsMax: 4,
    },
    retention: {
      etat: 'ok',
      message: 'Dernier passage réussi, rien en attente.',
      active: true,
      dernierPassage: null,
    },
    volumetrie: { scans24h: 12, scans7j: 1234, comptesActifs: 5, retoursOuverts: 2 },
    ...over,
  };
}

async function connecte(page: Page, permissions: Array<{ permission: string; gammes: null }> = []) {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        rank: 10,
        role: 'tester',
        status: 'active',
        permissions,
      }),
    ),
  );
}

const AVEC_SUPERVISION = [{ permission: 'health:read', gammes: null }] as const;

test.describe('Accès', () => {
  test('REFUSE qui ne détient pas health:read', async ({ page }) => {
    await connecte(page);
    await page.goto('/administration/supervision');

    await expect(page).toHaveURL(/acces-refuse/);
  });

  test('s’ouvre à qui le détient, sans exiger le rang le plus élevé', async ({ page }) => {
    // C'est une donnée d'exploitation, pas une pièce d'enquête.
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route => route.fulfill(json(releve())));

    await page.goto('/administration/supervision');
    await expect(page.getByRole('heading', { name: 'Supervision' })).toBeVisible();
  });

  test('la barre y mène', async ({ page }) => {
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route => route.fulfill(json(releve())));

    await page.goto('/tableau-de-bord');
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Supervision' })
      .click();

    await expect(page).toHaveURL(/administration\/supervision/);
  });
});

test.describe('Relevé', () => {
  test('affiche le verdict et les trois composants', async ({ page }) => {
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route => route.fulfill(json(releve())));
    await page.goto('/administration/supervision');

    await expect(page.getByText('Tout fonctionne normalement.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Base de données' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Pool d'analyse" })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rétention des rapports' })).toBeVisible();
  });

  test('DOUBLE la couleur par un libellé lisible', async ({ page }) => {
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route =>
      route.fulfill(
        json(
          releve({
            etat: 'panne',
            base: {
              etat: 'panne',
              message: 'Injoignable — les lectures et les écritures échouent.',
              active: true,
              latenceMs: null,
            },
            volumetrie: null,
          }),
        ),
      ),
    );
    await page.goto('/administration/supervision');

    await expect(page.getByText('En panne').first()).toBeVisible();
    await expect(page.getByText(/Indisponible — la volumétrie/)).toBeVisible();
  });

  test('CONSERVE le relevé quand le rafraîchissement échoue', async ({ page }) => {
    // Vider l'écran ferait croire à une panne plus grave que la panne réelle.
    let premier = true;
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route => {
      if (premier) {
        premier = false;
        return route.fulfill(json(releve()));
      }
      return route.fulfill(json({ message: 'panne' }, 500));
    });

    await page.goto('/administration/supervision');
    await expect(page.getByText('Connectée, 3 ms.')).toBeVisible();

    await page.getByRole('button', { name: 'Rafraîchir' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(/peut ne plus être à jour/)).toBeVisible();
    // Le relevé précédent est TOUJOURS là.
    await expect(page.getByText('Connectée, 3 ms.')).toBeVisible();
  });

  test('n’offre AUCUNE commande d’exploitation', async ({ page }) => {
    await connecte(page, [...AVEC_SUPERVISION]);
    await page.route('**/api/v1/supervision', route => route.fulfill(json(releve())));
    await page.goto('/administration/supervision');
    await expect(page.getByRole('heading', { name: 'Supervision' })).toBeVisible();

    for (const nom of [/Redémarrer/, /Purger/, /Forcer/, /Vider/]) {
      await expect(page.getByRole('button', { name: nom })).toHaveCount(0);
    }
  });
});
