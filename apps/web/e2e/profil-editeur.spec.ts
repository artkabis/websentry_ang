import { expect, test, type Page } from '@playwright/test';

/**
 * Éditeur de profil — ce qu'il en coûte de l'atteindre au clavier.
 *
 * L'écran porte une centaine de contrôles : deux grilles de vingt-neuf lignes,
 * des listes, et une carte par règle de page. Déplié d'un bloc, il demandait
 * 113 tabulations pour atteindre « Enregistrer » — 230 avec trois règles — et
 * six écrans et demi de défilement. Ce scénario garde la mesure : le repli est
 * une garantie d'accès, pas un effet de présentation.
 */

const ME = {
  id: 'u1',
  username: 'alice',
  rank: 50,
  role: 'admin',
  status: 'active',
  permissions: [],
};

const CHECKS = Array.from({ length: 29 }, (_, i) => ({
  id: `CHECK_${i}`,
  title: `Critère numéro ${i}`,
  group: i % 2 ? ('SEO' as const) : ('Design' as const),
}));

const PROFIL = {
  profile: 'premium',
  label: 'Premium',
  description: null,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: 'alice',
  settings: {},
};

async function mockApi(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/auth/me', r => r.fulfill(json(ME)));
  await page.route('**/api/v1/registry', r => r.fulfill(json({ checks: CHECKS, subChecks: [] })));
  await page.route('**/api/v1/profiles/premium', r => r.fulfill(json(PROFIL)));
}

/**
 * Arrêts de tabulation RÉELS.
 *
 * Compter les éléments focusables du DOM serait un proxy trompeur : le contenu
 * d'une section repliée y figure encore, alors que le navigateur ne s'y arrête
 * pas. On tabule donc pour de bon, depuis le haut du document.
 */
async function compterTabulations(page: Page, maximum = 400): Promise<number> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    // Le point de départ de la tabulation suit le dernier élément focalisé :
    // sans le replacer en tête, on ne compterait que la fin du formulaire.
    const titre = document.querySelector('h1');
    if (titre) {
      titre.setAttribute('tabindex', '-1');
      titre.focus();
    }
  });

  let arrets = 0;
  for (let i = 0; i < maximum; i++) {
    await page.keyboard.press('Tab');
    const encoreDansLaPage = await page.evaluate(
      () => document.activeElement !== null && document.activeElement !== document.body,
    );
    if (!encoreDansLaPage) break;
    arrets += 1;
  }
  return arrets;
}

test.describe('Éditeur de profil', () => {
  test('reste ATTEIGNABLE au clavier, replié par défaut', async ({ page }) => {
    await mockApi(page);
    await page.goto('/profils/premium');
    await expect(page.getByRole('heading', { name: 'Premium' })).toBeVisible();

    const arrets = await compterTabulations(page);

    // Mesuré à 27 sur cet écran ; la marge absorbe un contrôle ajouté, pas une
    // section dépliée d'office — qui en coûterait trente d'un coup.
    expect(arrets).toBeLessThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2000);
  });

  test('une règle par page coûte UNE tabulation, pas trente-neuf', async ({ page }) => {
    await mockApi(page);
    await page.goto('/profils/premium');
    await page.getByRole('heading', { name: 'Premium' }).waitFor();

    const avant = await compterTabulations(page);
    await page.locator('summary', { hasText: 'Règles par page' }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Ajouter une règle' }).click();
    }
    const apres = await compterTabulations(page);

    // Trois cartes repliées : trois en-têtes, et rien d'autre à traverser.
    expect(apres - avant).toBeLessThanOrEqual(10);
  });

  test('le contenu d’une section repliée n’est PAS atteignable — et l’est une fois ouverte', async ({
    page,
  }) => {
    // C'est la contrepartie du repli : ce qui est caché doit pouvoir être
    // montré, et l'en-tête doit dire ce qu'il cache.
    await mockApi(page);
    await page.goto('/profils/premium');

    // Le profil hérite des mots-outils par défaut du schéma : l'en-tête doit
    // le dire sans qu'on ait à ouvrir la section.
    const entete = page.locator('summary', { hasText: 'Mots exclus des titres' });
    await expect(entete).toContainText('22 mots exclus');
    const champ = page.getByRole('textbox', { name: 'Mot à exclure' });
    await expect(champ).toBeHidden();

    await entete.click();

    await expect(champ).toBeVisible();
  });

  test('RETIENT ce qui a été ouvert d’une visite à l’autre', async ({ page }) => {
    // Un profil se règle en plusieurs passes : refermer à chaque rechargement
    // ce qu'on vient d'ouvrir ferait perdre le temps que le repli fait gagner.
    await mockApi(page);
    await page.goto('/profils/premium');
    await page.locator('summary', { hasText: 'Pondération des critères' }).click();

    await page.reload();

    await expect(page.getByLabel('Pondération — Critère numéro 0')).toBeVisible();
  });

  test('offre un raccourci vers les actions (WCAG 2.4.1)', async ({ page }) => {
    await mockApi(page);
    await page.goto('/profils/premium');
    await page.getByRole('heading', { name: 'Premium' }).waitFor();

    // Le raccourci n'est visible qu'au clavier : on l'atteint comme un
    // utilisateur au clavier, et on l'active à la touche Entrée.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const titre = document.querySelector('h1');
      titre?.setAttribute('tabindex', '-1');
      (titre as HTMLElement | null)?.focus();
    });
    const evitement = page.getByRole('link', { name: 'Aller aux actions' });
    // Il vient juste avant le formulaire — après le titre et le bouton de
    // retour, qui sont peu nombreux et dont on ne veut pas figer le compte.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      if (await evitement.evaluate(el => el === document.activeElement)) break;
    }
    await expect(evitement).toBeFocused();
    // Invisible tant qu'on ne l'atteint pas, visible dès qu'on y est.
    await expect(evitement).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('#actions-profil')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeFocused();
  });
});
