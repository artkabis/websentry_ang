import { expect, test, type Page } from '@playwright/test';

/**
 * Apparence, vérifiée sur les couleurs CALCULÉES.
 *
 * Une feuille de style ne se teste pas en lisant ses classes : une classe peut
 * être écrite dans un gabarit sans qu'aucune règle ne la serve, et le gabarit
 * paraît juste. Ces scénarios interrogent donc le navigateur — ce qu'il a
 * réellement appliqué — et non le code qui prétend l'avoir demandé.
 */

const ME = {
  id: 'u1',
  username: 'alice',
  rank: 50,
  role: 'admin',
  status: 'active',
  permissions: [],
};

async function mockAuthenticated(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
}

test.describe('Feuille de style', () => {
  test('les utilitaires Tailwind sont réellement COMPILÉS', async ({ page }) => {
    // Le fichier de configuration PostCSS porte un nom qu'Angular ne lisait
    // pas : la feuille partait en production avec sa directive `@tailwind`
    // intacte, donc sans une seule classe utilitaire. Rien ne le signalait —
    // les gabarits étaient corrects, et aucun test ne regardait le rendu.
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');

    const fond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(fond).not.toBe('rgba(0, 0, 0, 0)');

    // Une classe de mise en forme quelconque doit, elle aussi, produire un effet.
    const carte = page.getByRole('heading', { name: 'Profils par gamme' }).locator('..');
    const rayon = await carte.evaluate(el => getComputedStyle(el).borderRadius);
    expect(rayon).not.toBe('0px');
  });
});
