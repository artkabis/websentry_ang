import { expect, test, type Page } from '@playwright/test';

/**
 * Portail de documentation, vérifié dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne prouvent pas : qu'un terme de recherche
 * survit à un rechargement, qu'un lien interne mène réellement à l'autre
 * page, qu'une ancre profonde atteint son titre — et surtout qu'un contenu
 * qui ressemble à du HTML reste du TEXTE une fois le vrai moteur de rendu à
 * l'œuvre. Un jsdom peut mentir là-dessus ; Chromium, non.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const PREMIERS_PAS = {
  slug: 'premiers-pas',
  titre: 'Premiers pas',
  section: 'Démarrer',
  ordre: 0,
  resume: 'Lancer une première analyse en trois gestes.',
};

const PROFILS = {
  slug: 'profils',
  titre: 'Profils',
  section: 'Démarrer',
  ordre: 1,
  resume: 'Choisir la gamme qui sert de référence.',
};

const SOMMAIRE = { sections: [{ section: 'Démarrer', pages: [PREMIERS_PAS, PROFILS] }] };

const PAGES: Record<string, unknown> = {
  'premiers-pas': {
    ...PREMIERS_PAS,
    blocs: [
      { type: 'titre', niveau: 2, texte: 'Avant de commencer', ancre: 'avant-de-commencer' },
      {
        type: 'paragraphe',
        contenu: [
          { type: 'texte', texte: 'Commencez par choisir ' },
          { type: 'lien', texte: 'un profil', href: 'doc:profils' },
          { type: 'texte', texte: '.' },
        ],
      },
      { type: 'titre', niveau: 2, texte: 'Lancer une analyse', ancre: 'lancer-une-analyse' },
      {
        type: 'paragraphe',
        // Ce qui ressemble à du balisage doit rester du texte à l'écran.
        contenu: [{ type: 'texte', texte: '<img src=x onerror="window.__xss = 1">' }],
      },
      { type: 'code', langage: 'bash', texte: 'pnpm dev:web' },
      {
        type: 'note',
        ton: 'avertissement',
        contenu: [{ type: 'texte', texte: 'Une analyse consomme du quota.' }],
      },
    ],
  },
  profils: {
    ...PROFILS,
    blocs: [{ type: 'paragraphe', contenu: [{ type: 'texte', texte: 'Trois gammes existent.' }] }],
  },
};

async function connecte(page: Page, rank = 50): Promise<void> {
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

/** Routes du portail. Les termes cherchés sont accumulés. */
async function mockApi(page: Page, options: { termes?: string[] } = {}): Promise<void> {
  await page.route(/\/api\/v1\/docs\/recherche(\?.*)?$/, route => {
    const terme = new URL(route.request().url()).searchParams.get('q') ?? '';
    options.termes?.push(terme);
    const resultats = terme.includes('profil')
      ? [{ ...PROFILS, extrait: '…la gamme qui sert de référence…', score: 3 }]
      : [];
    return route.fulfill(json({ q: terme, resultats, total: resultats.length }));
  });

  await page.route(/\/api\/v1\/docs\/[a-z0-9-]+$/, route => {
    const slug = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const page = PAGES[slug];
    return page
      ? route.fulfill(json(page))
      : route.fulfill(json({ message: 'Page de documentation introuvable.' }, 404));
  });

  await page.route(/\/api\/v1\/docs$/, route => route.fulfill(json(SOMMAIRE)));
}

test.describe('Accès', () => {
  test('est REFUSÉ à qui n’a pas docs:read', async ({ page }) => {
    await connecte(page, 10);
    await mockApi(page);

    await page.goto('/aide');

    await expect(page.getByRole('heading', { name: /refusé/i })).toBeVisible();
  });

  test('la barre y mène pour qui le détient', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/tableau-de-bord');
    await page.getByRole('link', { name: 'Aide' }).click();

    await expect(page.getByRole('heading', { name: 'Aide', level: 1 })).toBeVisible();
  });
});

test.describe('Lecture', () => {
  test('ouvre une page depuis le sommaire sans le perdre', async ({ page }) => {
    // Le sommaire reste : c'est ce qui distingue un portail consultable d'une
    // suite d'écrans sans retour.
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide');
    const sommaire = page.getByRole('navigation', { name: "Sommaire de l'aide" });
    await sommaire.getByRole('link', { name: 'Premiers pas' }).click();

    await expect(page).toHaveURL(/\/aide\/premiers-pas$/);
    await expect(page.getByRole('heading', { name: 'Premiers pas', level: 2 })).toBeVisible();
    await expect(sommaire.getByRole('link', { name: 'Profils' })).toBeVisible();
  });

  test('SUIT un lien interne d’une page à l’autre', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide/premiers-pas');
    await page.getByRole('link', { name: 'un profil' }).click();

    await expect(page).toHaveURL(/\/aide\/profils$/);
    await expect(page.getByText('Trois gammes existent.')).toBeVisible();
  });

  test('ATTEINT un titre par son ancre', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide/premiers-pas');
    await page
      .getByRole('navigation', { name: 'Sur cette page' })
      .getByRole('link', {
        name: 'Lancer une analyse',
      })
      .click();

    await expect(page).toHaveURL(/#lancer-une-analyse$/);
    await expect(page.locator('#lancer-une-analyse')).toBeVisible();
  });

  test('DIT ce qui manque quand la page n’existe pas', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide/inexistante');

    const alerte = page.getByRole('alert');
    await expect(alerte).toContainText('n’existe pas');
    await alerte.getByRole('link', { name: 'Revenir au sommaire' }).click();
    await expect(page).toHaveURL(/\/aide$/);
  });
});

test.describe('Sécurité du rendu', () => {
  test('n’INTERPRÈTE JAMAIS le contenu comme du balisage', async ({ page }) => {
    // Le cœur du module : l'API rend une structure, pas du HTML. Aucun
    // assainisseur n'est en jeu — il n'y a simplement rien à interpréter.
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide/premiers-pas');
    await expect(page.getByText('<img src=x onerror="window.__xss = 1">')).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__xss'])).toBe(
      undefined,
    );
    expect(await page.locator('article img').count()).toBe(0);
  });
});

test.describe('Recherche', () => {
  test('le terme VOYAGE dans l’URL et survit à un rechargement', async ({ page }) => {
    // Un résultat se partage et se remet en favori, ou il ne sert qu'une fois.
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide');
    await page.getByRole('searchbox', { name: /Rechercher/ }).fill('profil');

    await expect(page).toHaveURL(/\?q=profil$/);
    await expect(page.getByText('…la gamme qui sert de référence…')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('searchbox', { name: /Rechercher/ })).toHaveValue('profil');
    await expect(page.getByText('…la gamme qui sert de référence…')).toBeVisible();
  });

  test('N’INTERROGE PAS l’API sous deux caractères', async ({ page }) => {
    const termes: string[] = [];
    await connecte(page);
    await mockApi(page, { termes });

    await page.goto('/aide');
    await page.getByRole('searchbox', { name: /Rechercher/ }).fill('p');
    await expect(page.getByText(/Encore un caractère/)).toBeVisible();

    expect(termes).toEqual([]);
  });

  test('la touche « / » met le curseur dans la recherche', async ({ page }) => {
    // Le raccourci du geste quotidien : il ne se prouve qu'avec un vrai
    // clavier, sur un vrai document.
    await connecte(page);
    await mockApi(page);

    await page.goto('/aide');
    await page.getByRole('heading', { name: 'Aide', level: 1 }).click();
    await page.keyboard.press('/');

    await expect(page.getByRole('searchbox', { name: /Rechercher/ })).toBeFocused();
  });
});
