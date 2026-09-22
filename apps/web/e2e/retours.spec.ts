import { expect, test, type Page } from '@playwright/test';

/**
 * Retours des bêta-testeurs, vérifiés dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne prouvent pas : le contexte réellement capturé
 * au fil d'une navigation (la coquille ne se reconstruit pas entre deux
 * écrans), et le parcours complet du dépôt au triage.
 */

const ID = '11111111-1111-4111-8111-111111111111';

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function retour(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: 'bug',
    severity: 'majeur',
    status: 'nouveau',
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
    context: { route: '/profils/premium', targetUrl: null, gamme: null },
    authorId: 'u1',
    authorName: 'alice',
    assignedTo: null,
    assignedName: null,
    resolution: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

const COMPTEURS = { nouveau: 1, accepte: 0, en_cours: 0, resolu: 0, rejete: 0 };

/**
 * Suit le lien « Signaler » une fois qu'il porte l'écran attendu.
 *
 * Le lien est rendu dès que la session est résolue, mais sa cible suit les
 * ÉVÉNEMENTS du routeur : cliquer sans attendre le tombait parfois avec un
 * contexte encore vide. Affirmer l'adresse avant de cliquer rend le scénario
 * déterministe et vérifie en prime le contrat lui-même — le lien doit désigner
 * l'écran courant, ce que la page d'arrivée ne prouve qu'indirectement.
 */
async function signalerDepuis(page: Page, ecran: string): Promise<void> {
  // `exact` : l'écran des retours porte aussi « Signaler quelque chose ».
  const lien = page.getByRole('link', { name: 'Signaler', exact: true });
  await expect(lien).toHaveAttribute(
    'href',
    `/retours/nouveau?depuis=${encodeURIComponent(ecran)}`,
  );
  await lien.click();
}

/**
 * Les permissions doivent porter leur PORTÉE : le schéma partagé est strict,
 * et un profil incomplet est rejeté à la frontière — `hasPermission` rendrait
 * alors faux pour la seule raison que le double était mal formé.
 */
async function connecte(
  page: Page,
  permissions: Array<{ permission: string; gammes: string[] | null }> = [],
) {
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
  await page.route('**/api/v1/profiles', route => route.fulfill(json([])));
}

/** Routes des retours. Le dépôt renvoie la charge reçue pour pouvoir l'observer. */
async function mockApi(
  page: Page,
  options: { items?: unknown[]; deposes?: unknown[] } = {},
): Promise<void> {
  await page.route('**/api/v1/feedback/compteurs', route => route.fulfill(json(COMPTEURS)));
  await page.route(/\/api\/v1\/feedback(\?.*)?$/, async route => {
    if (route.request().method() === 'POST') {
      const charge = route.request().postDataJSON() as Record<string, unknown>;
      options.deposes?.push(charge);
      await route.fulfill(json(retour(charge), 201));
      return;
    }
    await route.fulfill(json({ items: options.items ?? [retour()], total: 1 }));
  });
  await page.route(`**/api/v1/feedback/${ID}`, route =>
    route.fulfill(json(retour(route.request().postDataJSON?.() ?? { status: 'accepte' }))),
  );
}

test.describe('Dépôt d’un retour', () => {
  test('CAPTURE l’écran d’où l’on vient, sans le demander', async ({ page }) => {
    // La coquille ne se reconstruit pas d'une navigation à l'autre : un lien
    // figé enverrait toujours le premier écran visité.
    const deposes: unknown[] = [];
    await connecte(page);
    await mockApi(page, { deposes });

    await page.goto('/profils');
    await signalerDepuis(page, '/profils');

    await expect(page.getByText(/sera joint automatiquement/)).toBeVisible();
    await expect(page.getByText('/profils')).toBeVisible();

    await page.getByRole('textbox', { name: /Titre/ }).fill('Le score ne se recalcule pas');
    await page
      .getByRole('textbox', { name: /Description/ })
      .fill('Après avoir changé la pondération, le score reste celui d’avant.');
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect(page).toHaveURL(/\/retours\?ouvert=/);
    expect(deposes).toHaveLength(1);
    expect((deposes[0] as { context: { route: string } }).context.route).toBe('/profils');
  });

  test('SUIT la navigation — le contexte n’est pas figé au démarrage', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/retours');
    await page.goto('/historique');
    await signalerDepuis(page, '/historique');

    await expect(page.getByText('/historique')).toBeVisible();
  });

  test('N’EMPORTE PAS la chaîne de requête de l’écran', async ({ page }) => {
    // Les filtres n'apprennent rien sur le problème, et peuvent contenir une
    // recherche nominative.
    await connecte(page);
    await mockApi(page);

    // Le lien lui-même ne doit porter QUE le chemin : c'est là que se joue la
    // règle, avant même d'arriver sur l'écran de dépôt.
    await page.goto('/retours?recherche=quelquun');
    await signalerDepuis(page, '/retours');

    await expect(page).not.toHaveURL(/recherche/);
  });

  test('GARDE l’envoi inactif tant que le retour est incomplet', async ({ page }) => {
    await connecte(page);
    await mockApi(page);
    await page.goto('/retours/nouveau');

    await expect(page.getByRole('button', { name: 'Envoyer' })).toBeDisabled();

    await page.getByRole('textbox', { name: /Titre/ }).fill('Un titre correct');
    await page.getByRole('textbox', { name: /Description/ }).fill('Une description complète.');
    await expect(page.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
  });
});

test.describe('Liste et triage', () => {
  test('OUVRE le retour qu’on vient de déposer', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto(`/retours?ouvert=${ID}`);
    await expect(page.getByText(/le score reste celui d’avant/)).toBeVisible();
  });

  test('n’offre AUCUN triage à un testeur', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/retours');
    await expect(page.getByRole('heading', { name: 'Retours' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Marquer/ })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /miens/ })).toHaveCount(0);
  });

  test('offre les SEULS passages autorisés à qui détient feedback:read', async ({ page }) => {
    await connecte(page, [{ permission: 'feedback:read', gammes: null }]);
    await mockApi(page);

    await page.goto('/retours');
    await expect(page.getByRole('button', { name: 'Marquer « Accepté »' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Marquer « Rejeté »' })).toBeVisible();
    // Sauter à « résolu » depuis « nouveau » n'est pas proposé, parce que
    // l'API le refuserait.
    await expect(page.getByRole('button', { name: 'Marquer « Résolu »' })).toHaveCount(0);
  });

  test('un compteur FILTRE la liste, et se retire au second clic', async ({ page }) => {
    await connecte(page, [{ permission: 'feedback:read', gammes: null }]);
    await mockApi(page);

    await page.goto('/retours');
    await page.getByRole('button', { name: /Résolu/ }).click();
    await expect(page).toHaveURL(/statut=resolu/);

    await page.getByRole('button', { name: /Résolu/ }).click();
    await expect(page).not.toHaveURL(/statut=/);
  });

  test('REFLÈTE les filtres dans l’URL, et les relit au rechargement', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/retours');
    await page.getByRole('searchbox', { name: /Recherche/ }).fill('score');
    await page.getByRole('combobox', { name: /Type/ }).selectOption('bug');
    await page.getByRole('button', { name: 'Filtrer' }).click();

    await expect(page).toHaveURL(/recherche=score/);
    await page.reload();
    await expect(page.getByRole('searchbox', { name: /Recherche/ })).toHaveValue('score');
    await expect(page.getByRole('combobox', { name: /Type/ })).toHaveValue('bug');
  });
});

test.describe('Accès', () => {
  test('la barre mène aux retours, sans permission particulière', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/tableau-de-bord');
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Retours' })
      .click();

    await expect(page).toHaveURL(/\/retours/);
  });
});
