import { expect, test, type Page } from '@playwright/test';

/**
 * Écrans d'administration, vérifiés dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne peuvent pas prouver : le parcours au clavier
 * (jsdom n'applique pas la règle de rendu qui masque un contenu replié) et le
 * routage réel entre la liste, la fiche et le journal.
 */

const ID_MOI = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';
const ID_PATRON = '33333333-3333-4333-8333-333333333333';

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function compte(over: Record<string, unknown> = {}) {
  return {
    id: ID_BOB,
    username: 'bob',
    displayName: 'Bob Martin',
    email: 'bob@exemple.fr',
    rank: 10,
    role: 'tester',
    status: 'active',
    lockedUntil: null,
    totalScansLaunched: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function trace(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    actorId: ID_MOI,
    actorName: 'alice',
    action: 'user.create',
    targetId: ID_BOB,
    targetType: 'user',
    details: { username: 'bob', rank: 10 },
    ipAddress: '203.0.113.7',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...over,
  };
}

/** Session dont le rang détermine ce que l'interface propose. */
async function connecte(page: Page, rank = 50): Promise<void> {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill(
      json({
        id: ID_MOI,
        username: 'alice',
        rank,
        role: rank >= 100 ? 'super_admin' : 'admin',
        status: 'active',
        permissions: [],
      }),
    ),
  );
}

/** Routes de l'administration — liste, fiche, permissions, journal. */
async function mockApi(
  page: Page,
  options: { users?: unknown[]; total?: number; entries?: unknown[] } = {},
): Promise<void> {
  const users = options.users ?? [
    compte(),
    compte({ id: ID_PATRON, username: 'patron', rank: 100, role: 'super_admin' }),
  ];

  await page.route(/\/api\/v1\/users(\?.*)?$/, route =>
    route.fulfill(json({ users, total: options.total ?? users.length })),
  );
  await page.route(`**/api/v1/users/${ID_BOB}`, route => route.fulfill(json(compte())));
  await page.route(`**/api/v1/users/${ID_BOB}/permissions`, route => route.fulfill(json([])));
  await page.route(/\/api\/v1\/audit(\?.*)?$/, route =>
    route.fulfill(json({ entries: options.entries ?? [trace()], total: 1 })),
  );
}

/**
 * Compte les arrêts réels de tabulation.
 *
 * Compter les éléments focusables du DOM serait trompeur : le contenu d'une
 * section repliée y figure encore, alors que le navigateur ne s'y arrête pas.
 */
async function compterTabulations(page: Page, maximum = 200): Promise<number> {
  // Un clic en haut à gauche ne convient PAS : c'est là que se place le lien
  // d'évitement une fois focalisé, et cliquer dessus sauterait l'en-tête —
  // on mesurerait alors l'écran seul, en croyant mesurer le parcours entier.
  // La coquille affiche son état de chargement tant que /auth/me n'a pas
  // répondu : tabuler avant qu'elle existe donnerait un résultat qui dépend de
  // la vitesse de la machine.
  await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeAttached();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
  const vus = new Set<string>();

  for (let i = 0; i < maximum; i += 1) {
    await page.keyboard.press('Tab');
    const signature = await page.evaluate(() => {
      const actif = document.activeElement;
      if (!actif || actif === document.body) return null;
      return `${actif.tagName}|${actif.getAttribute('name') ?? ''}|${(actif.textContent ?? '').slice(0, 24)}`;
    });
    if (signature === null) break;
    if (vus.has(signature)) break;
    vus.add(signature);
  }
  return vus.size;
}

test.describe('Liste des comptes', () => {
  test('affiche les comptes et mène à leur fiche', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto('/administration/comptes');

    await expect(page.getByRole('heading', { name: 'Comptes' })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: /bob/ })).toBeVisible();

    await page.getByRole('link', { name: 'Ouvrir la fiche de bob' }).click();
    await expect(page).toHaveURL(new RegExp(`/administration/comptes/${ID_BOB}$`));
    await expect(page.getByRole('heading', { name: /Compte bob/ })).toBeVisible();
  });

  test('n’offre PAS d’agir sur un compte de rang supérieur', async ({ page }) => {
    // Le garde-fou du service refuserait en 403 : l'interface l'explique avant
    // le clic plutôt que de le laisser découvrir après.
    await connecte(page);
    await mockApi(page);
    await page.goto('/administration/comptes');

    await expect(page.getByRole('link', { name: 'Ouvrir la fiche de patron' })).toHaveCount(0);
    await expect(page.getByText(/rang supérieur ou égal/).first()).toBeVisible();
  });

  test('REFLÈTE les filtres dans l’URL, et les relit au rechargement', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto('/administration/comptes');

    await page.getByRole('searchbox', { name: 'Recherche' }).fill('bob');
    await page.getByRole('combobox', { name: 'Statut' }).selectOption('suspended');
    await page.getByRole('button', { name: 'Filtrer' }).click();

    await expect(page).toHaveURL(/recherche=bob/);
    await expect(page).toHaveURL(/statut=suspended/);

    // Un lien partagé doit rouvrir la même recherche, champs compris.
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Recherche' })).toHaveValue('bob');
    await expect(page.getByRole('combobox', { name: 'Statut' })).toHaveValue('suspended');
  });

  test('reste parcourable au clavier en un nombre raisonnable d’arrêts', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto('/administration/comptes');
    await expect(page.getByRole('rowheader', { name: /bob/ })).toBeVisible();

    const arrets = await compterTabulations(page);
    expect(arrets).toBeGreaterThan(4);
    // Coquille comprise : lien d'évitement, logo, entrées de navigation et
    // choix d'apparence forment un coût FIXE, que le lien d'évitement permet
    // de sauter en un seul arrêt.
    expect(arrets).toBeLessThanOrEqual(32);
  });
});

test.describe('Fiche d’un compte', () => {
  test('n’active « Enregistrer » qu’une fois quelque chose modifié', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto(`/administration/comptes/${ID_BOB}`);

    const enregistrer = page.getByRole('button', { name: 'Enregistrer' });
    await expect(enregistrer).toBeDisabled();

    await page.getByRole('combobox', { name: 'Statut' }).selectOption('suspended');
    await expect(enregistrer).toBeEnabled();
  });

  test('CONFIRME avant de supprimer, en nommant le compte', async ({ page }) => {
    await connecte(page, 100);
    await mockApi(page);
    await page.goto(`/administration/comptes/${ID_BOB}`);

    await page.getByRole('button', { name: 'Supprimer…' }).click();
    await expect(page.getByText(/Supprimer définitivement/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Oui, supprimer' })).toBeVisible();
  });

  test('génère un mot de passe qui satisfait la règle de longueur', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto(`/administration/comptes/${ID_BOB}`);

    const champ = page.getByRole('textbox', { name: 'Nouveau mot de passe' });
    await page
      .locator('section', { has: page.getByRole('heading', { name: /Réinitialiser/ }) })
      .getByRole('button', { name: 'Générer' })
      .click();

    await expect(champ).not.toHaveValue('');
    expect((await champ.inputValue()).length).toBeGreaterThanOrEqual(12);
    await expect(page.getByRole('button', { name: 'Réinitialiser', exact: true })).toBeEnabled();
  });
});

test.describe('Journal d’audit', () => {
  test('est REFUSÉ à un administrateur', async ({ page }) => {
    // Le journal est réservé au rang 100 : la garde de route évite d'afficher
    // un écran que l'API refuserait de nourrir.
    await connecte(page, 50);
    await mockApi(page);
    await page.goto('/administration/journal');

    await expect(page).toHaveURL(/acces-refuse/);
  });

  test('s’ouvre pour un super administrateur, détail replié', async ({ page }) => {
    await connecte(page, 100);
    await mockApi(page);
    await page.goto('/administration/journal');

    await expect(page.getByRole('heading', { name: "Journal d'audit" })).toBeVisible();
    await expect(page.getByText('Compte créé')).toBeVisible();

    // Le détail est replié : son contenu n'est pas visible tant qu'on n'ouvre pas.
    await expect(page.getByText(/"username": "bob"/)).toBeHidden();
    await page.getByText('Détail').click();
    await expect(page.getByText(/"username": "bob"/)).toBeVisible();
  });

  test('n’offre AUCUN geste d’écriture', async ({ page }) => {
    await connecte(page, 100);
    await mockApi(page);
    await page.goto('/administration/journal');
    await expect(page.getByRole('heading', { name: "Journal d'audit" })).toBeVisible();

    for (const nom of [/Supprimer/, /Purger/, /Modifier/]) {
      await expect(page.getByRole('button', { name: nom })).toHaveCount(0);
    }
  });

  test('BLOQUE un intervalle de dates inversé', async ({ page }) => {
    await connecte(page, 100);
    await mockApi(page);
    await page.goto('/administration/journal');

    await page.getByLabel('Depuis le').fill('2026-02-01');
    await page.getByLabel("Jusqu'au").fill('2026-01-01');

    await expect(page.getByText(/postérieure à la date de fin/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filtrer' })).toBeDisabled();
  });
});

test.describe('Accès depuis le tableau de bord', () => {
  test('un admin voit les comptes, pas le journal', async ({ page }) => {
    await connecte(page, 50);
    await mockApi(page);
    await page.goto('/tableau-de-bord');

    await expect(page.getByRole('link', { name: /Gérer les comptes/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /journal d'audit/ })).toHaveCount(0);
  });

  test('un super_admin voit les deux', async ({ page }) => {
    await connecte(page, 100);
    await mockApi(page);
    await page.goto('/tableau-de-bord');

    await page.getByRole('link', { name: /journal d'audit/ }).click();
    await expect(page).toHaveURL(/administration\/journal/);
  });
});
