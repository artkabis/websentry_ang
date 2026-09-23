import { expect, test, type Page } from '@playwright/test';

/**
 * Analytics d'usage, vérifiés dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne prouvent pas : que la période voyage dans
 * l'URL et survit à un rechargement, que le graphe reste lisible sans être vu
 * — le tableau qui le double porte les mêmes nombres — et que l'écran est
 * refusé à qui n'a pas la permission.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function apercu(over: Record<string, unknown> = {}) {
  return {
    periode: '30j',
    depuis: '2026-03-01T12:00:00.000Z',
    jusqua: '2026-03-31T12:00:00.000Z',
    comptesActifs: 10,
    tunnel: [
      { cle: 'connexion', comptes: 10, actions: 50 },
      { cle: 'analyse', comptes: 6, actions: 120 },
      { cle: 'exploitation', comptes: 2, actions: 4 },
    ],
    parJour: [
      { jour: '2026-03-29', connexions: 2, analyses: 5 },
      { jour: '2026-03-30', connexions: 4, analyses: 30 },
      { jour: '2026-03-31', connexions: 1, analyses: 0 },
    ],
    gammes: [
      { gamme: 'premium', analyses: 80, scoreMoyen: 72.46 },
      { gamme: 'standard', analyses: 3, scoreMoyen: null },
    ],
    ...over,
  };
}

const REGISTRE = {
  sources: [
    {
      table: 'audit_log',
      finalite: 'Tracer les actions sensibles',
      donnees: ['identifiant de compte', 'adresse IP'],
      retentionJours: 180,
    },
    {
      table: 'users',
      finalite: 'Authentifier et autoriser',
      donnees: ['identifiant'],
      retentionJours: null,
    },
  ],
  anonymisation: { apresJours: 180, anonymisees: 1200, enAttente: 0, dernierPassage: null },
  collecteDediee: false,
};

async function connecte(page: Page, rank = 50) {
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
  await page.route('**/api/v1/profiles', route => route.fulfill(json([])));
  await page.route('**/api/v1/messages/compteurs', route =>
    route.fulfill(json({ total: 0, nonLus: 0, interrompt: 0 })),
  );
}

/** Routes de l'usage. Les périodes demandées sont accumulées. */
async function mockApi(
  page: Page,
  options: { vue?: Record<string, unknown>; periodes?: string[] } = {},
): Promise<void> {
  await page.route('**/api/v1/usage/gouvernance', route => route.fulfill(json(REGISTRE)));
  await page.route(/\/api\/v1\/usage(\?.*)?$/, route => {
    const periode = new URL(route.request().url()).searchParams.get('periode') ?? '';
    options.periodes?.push(periode);
    return route.fulfill(json({ ...(options.vue ?? apercu()), periode }));
  });
}

test.describe('Accès', () => {
  test('est REFUSÉ à qui n’a pas usage:read', async ({ page }) => {
    await connecte(page, 10);
    await mockApi(page);

    await page.goto('/administration/usage');

    await expect(page.getByRole('heading', { name: /refusé/i })).toBeVisible();
  });

  test('la barre y mène pour qui le détient', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/tableau-de-bord');
    await page.getByRole('link', { name: 'Usage' }).click();

    await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
  });
});

test.describe('Tunnel', () => {
  test('affiche les trois étapes et leur part', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');

    await expect(page.getByRole('heading', { name: "Tunnel d'usage" })).toBeVisible();
    await expect(page.getByLabel('100 % des comptes entrés')).toBeVisible();
    await expect(page.getByLabel('60 % des comptes entrés')).toBeVisible();
  });

  test('APPLIQUE le seuil d’anonymat à l’affichage', async ({ page }) => {
    // Un « 2 » désignerait quelqu'un dans une équipe de dix.
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');

    const exploitation = page
      .getByRole('heading', { name: 'Agissent sur ce qu’ils trouvent' })
      .locator('xpath=ancestor::li');
    await expect(exploitation).toContainText('moins de 5');
  });
});

test.describe('Courbe', () => {
  test('est DOUBLÉE par un tableau de chiffres', async ({ page }) => {
    // Un graphe est une image : sans le tableau, il ne dit rien à qui ne le
    // voit pas.
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');
    await page.getByText('Voir les chiffres jour par jour').click();

    const tableau = page.getByRole('table', { name: /jour par jour/ });
    await expect(tableau.getByRole('rowheader', { name: '30/03' })).toBeVisible();
    await expect(tableau.getByRole('cell', { name: '30', exact: true })).toBeVisible();
  });

  test('porte un LIBELLÉ résumant ce qu’elle montre', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');

    await expect(page.getByRole('img', { name: /35 analyse\(s\)/ })).toBeVisible();
  });
});

test.describe('Période', () => {
  test('voyage dans l’URL et SURVIT au rechargement', async ({ page }) => {
    const periodes: string[] = [];
    await connecte(page);
    await mockApi(page, { periodes });

    await page.goto('/administration/usage');
    await page.getByText('7 derniers jours').click();

    await expect(page).toHaveURL(/periode=7j/);
    await page.reload();

    await expect(page.getByRole('radio', { name: '7 derniers jours' })).toBeChecked();
    await expect.poll(() => periodes.at(-1)).toBe('7j');
  });

  test('n’écrit PAS la valeur par défaut dans l’URL', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage?periode=7j');
    await page.getByText('30 derniers jours').click();

    await expect(page).not.toHaveURL(/periode=/);
  });
});

test.describe('Registre de traitement', () => {
  test('ANNONCE qu’aucune collecte dédiée n’existe', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');

    await expect(page.getByText(/Aucune collecte dédiée/)).toBeVisible();
  });

  test('DIT quand une table n’est pas purgée', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');

    await expect(page.getByText('Aucune purge automatique')).toBeVisible();
    await expect(page.getByRole('cell', { name: '180 jours' })).toBeVisible();
  });

  test('reste affiché même sur une période VIDE', async ({ page }) => {
    // Ce que l'application conserve ne dépend pas de l'activité du mois.
    await connecte(page);
    await mockApi(page, { vue: apercu({ comptesActifs: 0, gammes: [] }) });

    await page.goto('/administration/usage');

    await expect(page.getByText(/Rien à mesurer pour l'instant/)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Ce que l'application conserve/ }),
    ).toBeVisible();
  });
});

test.describe('Ce que l’écran ne montre jamais', () => {
  test('n’affiche AUCUN nom ni adresse IP', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');
    await expect(page.getByRole('heading', { name: "Tunnel d'usage" })).toBeVisible();

    const texte = (await page.locator('main').textContent()) ?? '';
    expect(texte).not.toContain('alice');
    expect(texte).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  test('n’offre AUCUNE commande — pas même une purge', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/administration/usage');
    await expect(page.getByRole('heading', { name: "Tunnel d'usage" })).toBeVisible();

    for (const geste of [/anonymiser/i, /purger/i, /supprimer/i, /exporter/i]) {
      await expect(page.getByRole('button', { name: geste })).toHaveCount(0);
    }
  });
});
