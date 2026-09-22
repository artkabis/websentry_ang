import { expect, test, type Page } from '@playwright/test';

/**
 * Coquille applicative — navigation et lien d'évitement.
 *
 * Ce que les tests unitaires ne peuvent pas prouver : l'état actif (qui dépend
 * du routeur réel), le repli responsive (jsdom n'applique aucune requête média)
 * et le coût réel au clavier, qui se mesure en tabulant.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function connecte(page: Page, rank = 50): Promise<void> {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        rank,
        role: rank >= 100 ? 'super_admin' : 'admin',
        status: 'active',
        permissions: [],
      }),
    ),
  );
  // Les écrans visés chargent des données : on les sert vides, la coquille
  // seule est en cause ici.
  await page.route(/\/api\/v1\/(users|audit)(\?.*)?$/, route =>
    route.fulfill(json({ users: [], total: 0, entries: [] })),
  );
  await page.route('**/api/v1/profiles', route => route.fulfill(json([])));
}

/**
 * Remet le focus au tout début du document.
 *
 * Un clic en haut à gauche ne convient PAS : c'est exactement là que le lien
 * d'évitement se place une fois focalisé, et cliquer dessus déclencherait le
 * saut qu'on cherche justement à mesurer.
 */
async function remettreLeFocusAZero(page: Page): Promise<void> {
  // La coquille affiche son état de chargement tant que /auth/me n'a pas
  // répondu : tabuler avant que le lien d'évitement existe ne mesure rien, et
  // donne un résultat qui dépend de la vitesse de la machine.
  await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeAttached();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
}

/** Arrêts réels de tabulation, mesurés en tabulant. */
async function compterTabulations(page: Page, maximum = 200): Promise<number> {
  await remettreLeFocusAZero(page);
  const vus = new Set<string>();

  for (let i = 0; i < maximum; i += 1) {
    await page.keyboard.press('Tab');
    const signature = await page.evaluate(() => {
      const actif = document.activeElement;
      if (!actif || actif === document.body) return null;
      return `${actif.tagName}|${actif.getAttribute('name') ?? ''}|${(actif.textContent ?? '').slice(0, 24)}`;
    });
    if (signature === null || vus.has(signature)) break;
    vus.add(signature);
  }
  return vus.size;
}

test.describe('Navigation principale', () => {
  test('mène d’une FAMILLE à l’autre sans repasser par le tableau de bord', async ({ page }) => {
    // C'est la raison d'être de cette barre : l'application comptait seize
    // routes pour un seul point d'entrée.
    await connecte(page);
    await page.goto('/analyse');

    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Comptes' })
      .click();

    await expect(page).toHaveURL(/administration\/comptes/);
  });

  test('ANNONCE l’écran courant, pas seulement en couleur', async ({ page }) => {
    // Un fond coloré ne dit rien à un lecteur d'écran.
    await connecte(page);
    await page.goto('/historique');

    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Historique' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'Analyse' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('marque la FAMILLE active depuis un écran interne', async ({ page }) => {
    // `/analyse/lot` appartient à la famille « Analyse » : l'entrée doit rester
    // marquée, sans quoi l'utilisateur ne sait plus où il se trouve.
    await connecte(page);
    await page.goto('/analyse/lot');

    await expect(
      page
        .getByRole('navigation', { name: 'Navigation principale' })
        .getByRole('link', { name: 'Analyse' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('n’offre QUE ce que le rang permet d’ouvrir', async ({ page }) => {
    await connecte(page, 50);
    await page.goto('/tableau-de-bord');
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });

    await expect(nav.getByRole('link', { name: 'Comptes' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Journal' })).toHaveCount(0);
  });

  test('ouvre le journal au super administrateur', async ({ page }) => {
    await connecte(page, 100);
    await page.goto('/tableau-de-bord');

    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Journal' })
      .click();
    await expect(page).toHaveURL(/administration\/journal/);
  });

  test('SORT des écrans qui étaient des culs-de-sac', async ({ page }) => {
    // Le journal, la liste et l'éditeur de profils n'offraient aucune sortie
    // en dehors du logo.
    await connecte(page, 100);

    for (const ecran of ['/administration/journal', '/profils', '/profils/premium']) {
      await page.goto(ecran);
      await page
        .getByRole('navigation', { name: 'Navigation principale' })
        .getByRole('link', { name: 'Historique' })
        .click();
      await expect(page).toHaveURL(/\/historique/);
    }
  });
});

test.describe('Repli responsive', () => {
  test('déploie la barre sur un écran large, sans passer par « Menu »', async ({ page }) => {
    await connecte(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/tableau-de-bord');

    await expect(
      page
        .getByRole('navigation', { name: 'Navigation principale' })
        .getByRole('link', { name: 'Analyse' }),
    ).toBeVisible();
  });

  test('REPLIE la barre sur un téléphone, et l’ouvre au bouton', async ({ page }) => {
    await connecte(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tableau-de-bord');

    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Analyse' })).toBeHidden();

    await nav.getByRole('button', { name: 'Menu' }).click();
    await expect(nav.getByRole('link', { name: 'Analyse' })).toBeVisible();
  });

  test('REFERME le menu après une navigation', async ({ page }) => {
    // Le laisser ouvert masquerait l'écran qu'on vient d'ouvrir.
    await connecte(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tableau-de-bord');

    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await nav.getByRole('button', { name: 'Menu' }).click();
    await nav.getByRole('link', { name: 'Analyse' }).click();

    await expect(page).toHaveURL(/\/analyse/);
    await expect(nav.getByRole('link', { name: 'Historique' })).toBeHidden();
  });

  test('ne produit AUCUN défilement horizontal sur un téléphone', async ({ page }) => {
    await connecte(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tableau-de-bord');

    const deborde = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(deborde).toBe(false);
  });
});

test.describe('Lien d’évitement', () => {
  test('est le PREMIER arrêt, et saute la navigation', async ({ page }) => {
    // Sans lui, la barre coûterait ses arrêts sur chaque écran.
    await connecte(page);
    await page.goto('/tableau-de-bord');

    await remettreLeFocusAZero(page);
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveText('Aller au contenu');

    await page.keyboard.press('Enter');
    const focusId = await page.evaluate(() => document.activeElement?.id);
    expect(focusId).toBe('contenu');
  });

  test('n’emmène PAS ailleurs — la route reste la même', async ({ page }) => {
    // Avec une base de document à la racine, une ancre de fragment est résolue
    // en URL absolue : le routeur ramènerait à l'accueil.
    await connecte(page);
    await page.goto('/historique');

    await remettreLeFocusAZero(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/historique/);
  });

  test('n’occupe AUCUNE surface cliquable tant qu’on ne tabule pas', async ({ page }) => {
    // Un remplissage posé en permanence écraserait le « padding: 0 » de
    // sr-only et laisserait une cible de 24 px dans le coin, que le pointeur
    // atteindrait sans jamais la voir.
    await connecte(page);
    await page.goto('/tableau-de-bord');

    const boite = await page.getByRole('link', { name: 'Aller au contenu' }).boundingBox();
    expect(boite === null || (boite.width <= 2 && boite.height <= 2)).toBe(true);
  });

  test('devient une VRAIE cible une fois focalisé', async ({ page }) => {
    // WCAG 2.5.8 : 24 × 24 au minimum. Un lien d'évitement qu'on ne peut pas
    // viser à la souris ne sert qu'à moitié.
    await connecte(page);
    await page.goto('/tableau-de-bord');

    await remettreLeFocusAZero(page);
    await page.keyboard.press('Tab');

    const boite = await page.getByRole('link', { name: 'Aller au contenu' }).boundingBox();
    expect(boite).not.toBeNull();
    expect(boite!.width).toBeGreaterThanOrEqual(24);
    expect(boite!.height).toBeGreaterThanOrEqual(24);
  });
});

test.describe('Coût au clavier', () => {
  test('la coquille ajoute peu d’arrêts, et le contenu reste à UN saut', async ({ page }) => {
    await connecte(page);
    await page.goto('/administration/comptes');
    await expect(page.getByRole('heading', { name: 'Comptes' })).toBeVisible();

    const arrets = await compterTabulations(page);
    // Lien d'évitement, logo, six entrées, trois choix d'apparence, puis
    // l'écran lui-même : la barre reste un coût FIXE, et le lien d'évitement
    // permet de la sauter en un seul arrêt.
    expect(arrets).toBeLessThanOrEqual(30);
  });
});

test.describe('Mesure du coût fixe', () => {
  /**
   * Le chiffre que cette suite protège.
   *
   * La coquille ajoute des arrêts sur CHAQUE écran : il faut savoir combien,
   * et vérifier que le lien d'évitement les ramène à un seul pour qui veut
   * atteindre le contenu.
   */
  test('la barre ne coûte QUE ce que sa composition explique', async ({ page }) => {
    // Une seule traversée par test : une fois qu'on a tabulé, le point de
    // départ de la navigation séquentielle n'est plus le début du document, et
    // un second comptage dans le même test mesurerait autre chose.
    // Le raccourci par l'évitement est vérifié par « est le PREMIER arrêt ».
    await connecte(page, 100);
    await page.goto('/tableau-de-bord');

    // La borne est DÉRIVÉE de ce que la coquille affiche, et non figée à un
    // nombre : une entrée de navigation ajoutée déplacerait sinon un chiffre
    // magique sans qu'on sache si le coût est légitime. Ici, tout arrêt
    // supplémentaire non expliqué par la composition fait tomber le test.
    const entrees = await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link')
      .count();
    const attendu =
      1 /* lien d'évitement */ +
      1 /* logo */ +
      entrees +
      1 /* Signaler */ +
      // Le choix d'apparence est un GROUPE de boutons radio : il ne coûte
      // qu'UN arrêt, pas trois. Seul le bouton coché reçoit le focus, et les
      // flèches naviguent à l'intérieur du groupe — c'est le comportement
      // natif, et c'est ce qui rend un groupe radio préférable à trois
      // boutons pour qui navigue au clavier.
      1; /* choix d'apparence */

    await remettreLeFocusAZero(page);
    let avantContenu = 0;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      avantContenu += 1;
      const dansLeContenu = await page.evaluate(
        () => document.activeElement?.closest('#contenu') !== null,
      );
      if (dansLeContenu) break;
    }

    // Le dernier arrêt compté est le PREMIER du contenu : la coquille en coûte
    // donc un de moins.
    expect(avantContenu - 1).toBe(attendu);
  });
});
