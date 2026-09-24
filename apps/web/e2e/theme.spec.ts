import { expect, test, type Page } from '@playwright/test';

/**
 * Apparence, vérifiée sur les couleurs CALCULÉES.
 *
 * Une feuille de style ne se teste pas en lisant ses classes : une classe peut
 * être écrite dans un gabarit sans qu'aucune règle ne la serve, et le gabarit
 * paraît juste. Ces scénarios interrogent donc le navigateur — ce qu'il a
 * réellement appliqué — et non le code qui prétend l'avoir demandé.
 */

/**
 * Rang 100 : le balayage doit atteindre TOUS les écrans, y compris ceux que
 * les gardes réservent au rang le plus élevé.
 */
const ME = {
  id: 'u1',
  username: 'alice',
  rank: 100,
  role: 'super_admin',
  status: 'active',
  permissions: [],
};

async function mockAuthenticated(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );

  /*
   * La messagerie est nourrie, et pas seulement atteinte.
   *
   * Sans données, la boîte tomberait sur son état d'erreur : le balayage
   * vérifierait alors le contraste d'un bandeau rouge plutôt que celui des
   * trois familles d'importance, de la pastille de non-lus et des cartes — qui
   * sont précisément ce que cet écran apporte de neuf.
   */
  // `interrompt: 0` : une fenêtre d'irruption couvrirait CHAQUE écran du
  // balayage, et masquerait les couleurs qu'il est censé mesurer. Elle a sa
  // propre passe, à la fin.
  await page.route('**/api/v1/messages/compteurs', route =>
    route.fulfill(json({ total: 3, nonLus: 2, interrompt: 0 })),
  );
  await page.route(/\/api\/v1\/messages(\?.*)?$/, route =>
    route.fulfill(
      json({
        items: ['normale', 'haute', 'critique'].map((importance, i) => ({
          id: `1111111${i}-1111-4111-8111-11111111111${i}`,
          subject: `Message ${importance}`,
          body: 'Corps du message.',
          importance,
          authorId: 'u1',
          authorName: 'alice',
          attachments: [],
          sentAt: '2026-01-01T08:00:00.000Z',
          readAt: i === 0 ? '2026-01-02T00:00:00.000Z' : null,
          archivedAt: null,
        })),
        total: 3,
      }),
    ),
  );
  await page.route(/\/api\/v1\/users(\?.*)?$/, route =>
    route.fulfill(json({ users: [], total: 0 })),
  );

  /*
   * L'aide est nourrie, elle aussi.
   *
   * Le portail apporte des familles qu'aucun autre écran ne pose : encadrés
   * « note » et « avertissement », bloc de code sur fond creusé, liens de
   * contenu au fil du texte. Sans données, le balayage mesurerait un bandeau
   * d'erreur à leur place.
   */
  await page.route(/\/api\/v1\/docs$/, route =>
    route.fulfill(
      json({
        sections: [
          {
            section: 'Démarrer',
            pages: [
              {
                slug: 'premiers-pas',
                titre: 'Premiers pas',
                section: 'Démarrer',
                ordre: 0,
                resume: 'Lancer une première analyse en trois gestes.',
              },
            ],
          },
        ],
      }),
    ),
  );
  await page.route(/\/api\/v1\/docs\/[a-z0-9-]+$/, route =>
    route.fulfill(
      json({
        slug: 'premiers-pas',
        titre: 'Premiers pas',
        section: 'Démarrer',
        ordre: 0,
        resume: 'Lancer une première analyse en trois gestes.',
        blocs: [
          { type: 'titre', niveau: 2, texte: 'Avant de commencer', ancre: 'avant-de-commencer' },
          {
            type: 'paragraphe',
            contenu: [
              { type: 'texte', texte: 'Choisissez ' },
              { type: 'lien', texte: 'un profil', href: 'doc:premiers-pas' },
              { type: 'texte', texte: ', puis lancez ' },
              { type: 'code', texte: 'pnpm dev:web' },
              { type: 'fort', texte: ' en local' },
              { type: 'texte', texte: '.' },
            ],
          },
          { type: 'titre', niveau: 3, texte: 'Détail', ancre: 'detail' },
          { type: 'liste', ordonnee: true, elements: [[{ type: 'texte', texte: 'Un.' }]] },
          { type: 'code', langage: 'bash', texte: 'pnpm dev:api' },
          { type: 'note', ton: 'info', contenu: [{ type: 'texte', texte: 'Bon à savoir.' }] },
          {
            type: 'note',
            ton: 'avertissement',
            contenu: [{ type: 'texte', texte: 'Une analyse consomme du quota.' }],
          },
        ],
      }),
    ),
  );

  // L'usage est nourri, comme la messagerie : sans données, l'écran tomberait
  // sur son état d'erreur, et le balayage vérifierait un bandeau rouge plutôt
  // que les tableaux et les barres qu'il apporte.
  await page.route('**/api/v1/usage/gouvernance', route =>
    route.fulfill(
      json({
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
        anonymisation: {
          apresJours: 180,
          anonymisees: 1200,
          enAttente: 37,
          dernierPassage: '2026-03-30T03:00:00.000Z',
        },
        collecteDediee: false,
      }),
    ),
  );
  await page.route(/\/api\/v1\/usage(\?.*)?$/, route =>
    route.fulfill(
      json({
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
      }),
    ),
  );
}

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

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

/**
 * Tous les textes visibles d'une page, avec leur contraste.
 *
 * Un échantillon choisi à la main ne prouve que ce qu'on a pensé à y mettre :
 * le jeton mal employé est justement celui auquel on n'a pas pensé. On balaie
 * donc chaque élément portant du texte en propre, et on laisse la page dire
 * où elle pèche.
 */
function contrastesDeLaPage(): {
  texte: string;
  couleur: string;
  fond: string;
  ratio: number;
  minimum: number;
}[] {
  const pinceau = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const peindre = (couleur: string): [number, number, number, number] => {
    if (!pinceau) return [0, 0, 0, 0];
    pinceau.clearRect(0, 0, 1, 1);
    pinceau.fillStyle = couleur;
    pinceau.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pinceau.getImageData(0, 0, 1, 1).data;
    return [r ?? 0, g ?? 0, b ?? 0, a ?? 0];
  };
  const canal = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]: [number, number, number, number]): number =>
    0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);

  const resultats = [];
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    // Seul le texte porté EN PROPRE compte : sinon chaque conteneur serait
    // mesuré avec la couleur qu'il transmet, et le même défaut compterait dix
    // fois sans qu'on sache où il est.
    const propre = Array.from(element.childNodes)
      .filter(noeud => noeud.nodeType === Node.TEXT_NODE)
      .map(noeud => noeud.textContent ?? '')
      .join('')
      .trim();
    if (!propre) continue;

    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    // Texte réservé aux lecteurs d'écran : il n'est pas peint, donc pas lu à
    // l'œil. Sa boîte est réduite à un point.
    const boite = element.getBoundingClientRect();
    if (boite.width <= 1 || boite.height <= 1) continue;

    let fond: string | null = null;
    for (let noeud: Element | null = element; noeud; noeud = noeud.parentElement) {
      const couleur = getComputedStyle(noeud).backgroundColor;
      if (peindre(couleur)[3] === 255) {
        fond = couleur;
        break;
      }
    }
    if (!fond) continue;

    const couleur = style.color;
    const l1 = luminance(peindre(couleur));
    const l2 = luminance(peindre(fond));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    // WCAG 1.4.3 : 3:1 suffit au « grand texte » — 24 px, ou 18,66 px en gras.
    const taille = Number.parseFloat(style.fontSize);
    const gras = Number.parseInt(style.fontWeight, 10) >= 700;
    const minimum = taille >= 24 || (gras && taille >= 18.66) ? 3 : 4.5;

    resultats.push({ texte: propre.slice(0, 40), couleur, fond, ratio, minimum });
  }
  return resultats;
}

test.describe('Thème sombre', () => {
  test('BASCULE réellement les couleurs, et pas seulement un attribut', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');

    const clair = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByRole('radio', { name: 'Sombre' }).check();
    const sombre = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    expect(sombre).not.toBe(clair);
    // Le fond sombre est bien SOMBRE : un attribut posé sur une feuille qui ne
    // le sert pas laisserait la page blanche, et la comparaison ci-dessus ne
    // suffirait pas à le dire.
    const luminosite = (c: string) =>
      c
        .match(/\d+/g)!
        .slice(0, 3)
        .reduce((s, v) => s + Number(v), 0) / 3;
    expect(luminosite(sombre)).toBeLessThan(90);
    expect(luminosite(clair)).toBeGreaterThan(200);
  });

  test('SUIT le système tant que rien n’a été choisi', async ({ page }) => {
    await mockAuthenticated(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/tableau-de-bord');

    const fond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const luminosite =
      fond
        .match(/\d+/g)!
        .slice(0, 3)
        .reduce((s, v) => s + Number(v), 0) / 3;
    expect(luminosite).toBeLessThan(90);
    // Aucun attribut n'a été posé : c'est `color-scheme` qui a tranché, donc
    // avant même que le JavaScript de l'application ne démarre.
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(
      false,
    );
  });

  test('CONSERVE le choix d’un rechargement à l’autre', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/tableau-de-bord');
    await page.getByRole('radio', { name: 'Sombre' }).check();

    await page.reload();

    await expect(page.getByRole('radio', { name: 'Sombre' })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('sombre');
  });

  test('le choix EXPLICITE l’emporte sur la préférence système', async ({ page }) => {
    await mockAuthenticated(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/tableau-de-bord');

    await page.getByRole('radio', { name: 'Clair' }).check();

    const fond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const luminosite =
      fond
        .match(/\d+/g)!
        .slice(0, 3)
        .reduce((s, v) => s + Number(v), 0) / 3;
    expect(luminosite).toBeGreaterThan(200);
  });

  /**
   * Écrans balayés.
   *
   * Un seul écran ne prouverait que ses propres jetons. Ceux-ci couvrent les
   * quatre états que le cap UX impose — nominal, vide, erreur, chargement —
   * et les familles de couleur qui vont avec : marque, alerte, avertissement,
   * succès.
   */
  const ECRANS = [
    '/tableau-de-bord',
    '/analyse',
    '/analyse/lot',
    '/analyse/sitemap',
    '/historique',
    '/profils',
    // L'éditeur ouvre sur les valeurs par défaut quand la gamme n'existe pas :
    // sans API, il rend donc son formulaire complet — listes, pondérations,
    // boutons — ce qui en fait l'écran le plus dense à vérifier.
    '/profils/premium',
    // L'administration apporte ses propres familles : pastilles de statut
    // (succès, alerte, avertissement) et zone de suppression.
    '/administration/comptes',
    '/administration/comptes/nouveau',
    // Les retours apportent leurs propres pastilles de statut — cinq familles
    // de couleur sur un même écran.
    '/retours',
    '/retours/nouveau',
    // La supervision porte les trois familles d'état sur un même écran.
    '/administration/supervision',
    // La messagerie apporte trois familles d'importance, une pastille pleine
    // dans la barre, et un formulaire à cases et boutons radio.
    '/messages',
    '/messages/nouveau',
    // L'usage apporte deux tableaux denses, des barres de proportion et un
    // graphe — des aplats de marque sur fond creusé, jamais vérifiés ailleurs.
    '/administration/usage',
    // L'aide apporte deux tons d'encadré, un bloc de code et des liens au fil
    // du texte — des couleurs qu'aucun autre écran ne pose.
    '/aide',
    '/aide/premiers-pas',
  ];

  for (const theme of ['clair', 'sombre'] as const) {
    test(`tient WCAG 2.2 AA sur tous les écrans en thème ${theme}`, async ({ page }) => {
      // La vérification porte sur les couleurs CALCULÉES, pas sur les valeurs
      // déclarées dans la feuille : un jeton juste, servi au mauvais endroit,
      // donne un écran illisible, et seule la page rendue le dit.
      await mockAuthenticated(page);
      await page.goto('/tableau-de-bord');
      await page.getByRole('radio', { name: theme === 'clair' ? 'Clair' : 'Sombre' }).check();

      const fautifs: string[] = [];
      let mesures = 0;
      for (const ecran of ECRANS) {
        await page.goto(ecran);
        await expect(page.getByRole('heading').first()).toBeVisible();
        const page_ = await page.evaluate(contrastesDeLaPage);
        mesures += page_.length;
        for (const m of page_.filter(x => x.ratio < x.minimum)) {
          fautifs.push(
            `${ecran} — « ${m.texte} » ${m.couleur} sur ${m.fond} = ${m.ratio.toFixed(2)}`,
          );
        }
      }

      /*
       * La fenêtre d'irruption a sa propre passe.
       *
       * Elle ne s'ouvre que sur un message critique non lu, et elle couvrirait
       * les écrans du balayage si elle restait ouverte pendant. Son voile pose
       * pourtant un fond inhabituel sous un texte clair : c'est exactement le
       * genre d'endroit où un jeton passe inaperçu.
       */
      await page.route('**/api/v1/messages/compteurs', route =>
        route.fulfill(json({ total: 3, nonLus: 2, interrompt: 1 })),
      );
      await page.goto('/tableau-de-bord');
      await expect(page.getByRole('dialog')).toBeVisible();
      const fenetre = await page.evaluate(contrastesDeLaPage);
      mesures += fenetre.length;
      for (const m of fenetre.filter(x => x.ratio < x.minimum)) {
        fautifs.push(
          `irruption — « ${m.texte} » ${m.couleur} sur ${m.fond} = ${m.ratio.toFixed(2)}`,
        );
      }

      // Un balayage qui ne trouve rien passerait sans rien prouver.
      expect(mesures).toBeGreaterThan(60);
      expect(fautifs).toEqual([]);
    });
  }
});
