import { expect, test, type Page } from '@playwright/test';

/**
 * Messagerie in-app, vérifiée dans un vrai navigateur.
 *
 * Ce que les tests unitaires ne prouvent pas : qu'un message critique s'impose
 * PAR-DESSUS n'importe quel écran (la coquille ne se reconstruit pas d'une
 * navigation à l'autre), et qu'une pièce jointe part réellement en multipart —
 * un `FormData` construit en mémoire ne dit rien de ce qui passe sur le fil.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const ID_CRITIQUE = '22222222-2222-4222-8222-222222222222';
/** Les identifiants sont des UUID jusque dans les doubles : le schéma partagé
 *  est strict, et un « p-1 » ferait échouer la lecture pour la mauvaise raison. */
const ID_PIECE = '33333333-3333-4333-8333-333333333333';

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function message(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    subject: 'Bascule v2 jeudi',
    body: 'La bascule est programmée jeudi à 14h.',
    importance: 'haute',
    authorId: 'u1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T08:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

const CRITIQUE = message({
  id: ID_CRITIQUE,
  subject: 'Coupure de service ce soir',
  body: 'Maintenance à 20h. Aucun audit ne sera perdu.',
  importance: 'critique',
});

async function connecte(
  page: Page,
  permissions: Array<{ permission: string; gammes: string[] | null }> = [],
  rank = 10,
) {
  await page.route('**/api/v1/auth/me', route =>
    route.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        rank,
        role: rank >= 50 ? 'admin' : 'tester',
        status: 'active',
        permissions,
      }),
    ),
  );
  await page.route('**/api/v1/profiles', route => route.fulfill(json([])));
}

/** Routes de la messagerie. Les appels observés sont accumulés. */
async function mockApi(
  page: Page,
  options: {
    items?: unknown[];
    compteurs?: { total: number; nonLus: number; interrompt: number };
    envois?: { champs: Record<string, string>; fichiers: string[] }[];
    ouverts?: string[];
    archives?: { id: string; archived: boolean }[];
  } = {},
): Promise<void> {
  // Le double est ÉTATIQUE : marquer lu doit réellement faire tomber les
  // compteurs, sans quoi la fenêtre d'irruption se rouvrirait aussitôt — et le
  // test accuserait le composant d'un défaut qui n'est que dans le double.
  const compteurs = { ...(options.compteurs ?? { total: 1, nonLus: 1, interrompt: 0 }) };
  const lus = new Set<string>();

  await page.route('**/api/v1/messages/compteurs', route => route.fulfill(json(compteurs)));
  await page.route('**/api/v1/messages/tout-lu', route =>
    route.fulfill(json({ total: 1, nonLus: 0, interrompt: 0 })),
  );
  await page.route(/\/api\/v1\/messages\/[0-9a-f-]+\/lu$/, route => {
    const id = /messages\/([0-9a-f-]+)\/lu/.exec(route.request().url())?.[1] ?? '';
    options.ouverts?.push(id);
    if (!lus.has(id)) {
      lus.add(id);
      compteurs.nonLus = Math.max(0, compteurs.nonLus - 1);
      compteurs.interrompt = Math.max(0, compteurs.interrompt - 1);
    }
    return route.fulfill(json(message({ id, readAt: '2026-01-02T00:00:00.000Z' })));
  });
  await page.route(/\/api\/v1\/messages\/[0-9a-f-]+$/, route => {
    const id = /messages\/([0-9a-f-]+)$/.exec(route.request().url())?.[1] ?? '';
    if (route.request().method() === 'PATCH') {
      const corps = route.request().postDataJSON() as { archived: boolean };
      options.archives?.push({ id, archived: corps.archived });
      return route.fulfill(
        json(message({ id, archivedAt: corps.archived ? '2026-01-02T00:00:00.000Z' : null })),
      );
    }
    return route.fulfill(json(message({ id })));
  });
  await page.route(/\/api\/v1\/messages(\?.*)?$/, async route => {
    if (route.request().method() === 'POST') {
      // Le corps est du multipart : on le lit tel qu'il est parti sur le fil.
      const brut = route.request().postData() ?? '';
      const champs: Record<string, string> = {};
      const fichiers: string[] = [];
      for (const bloc of brut.split(/--[-\w]+/)) {
        const nom = /name="([^"]+)"/.exec(bloc)?.[1];
        if (!nom) continue;
        const fichier = /filename="([^"]*)"/.exec(bloc)?.[1];
        if (fichier !== undefined) {
          fichiers.push(fichier);
          continue;
        }
        champs[nom] = (bloc.split('\r\n\r\n')[1] ?? '').replace(/\r\n$/, '');
      }
      options.envois?.push({ champs, fichiers });
      return route.fulfill(json(message({ subject: champs['subject'] }), 201));
    }

    const url = new URL(route.request().url());
    const tous = (options.items ?? [message()]) as Record<string, unknown>[];
    // Le double REJOUE le filtre serveur : sans cela, un test de filtre
    // passerait sur une liste que rien n'a filtrée.
    const filtres = tous
      .map(m => (lus.has(String(m['id'])) ? { ...m, readAt: '2026-01-02T00:00:00.000Z' } : m))
      .filter(m => {
        const importance = url.searchParams.get('importance');
        if (importance && m['importance'] !== importance) return false;
        if (url.searchParams.get('unread') === 'true' && m['readAt'] !== null) return false;
        return true;
      });
    return route.fulfill(json({ items: filtres, total: filtres.length }));
  });
}

test.describe('Boîte de réception', () => {
  test('liste les messages et SIGNALE les non lus', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/messages');

    await expect(page.getByRole('heading', { name: /Bascule v2 jeudi/ })).toBeVisible();
    await expect(page.getByText('Non lu', { exact: true })).toBeVisible();
  });

  test('OUVRIR vaut lecture, sans geste supplémentaire', async ({ page }) => {
    const ouverts: string[] = [];
    await connecte(page);
    await mockApi(page, { ouverts });

    await page.goto('/messages');
    await page.getByText('Lire le message').click();

    await expect.poll(() => ouverts).toEqual([ID]);
  });

  test('ARCHIVE en retirant la ligne sans attendre le serveur', async ({ page }) => {
    const archives: { id: string; archived: boolean }[] = [];
    await connecte(page);
    await mockApi(page, { archives });

    await page.goto('/messages');
    await page.getByRole('button', { name: 'Archiver' }).click();

    await expect(page.getByRole('heading', { name: /Bascule v2 jeudi/ })).toBeHidden();
    await expect.poll(() => archives).toEqual([{ id: ID, archived: true }]);
  });

  test('REFLÈTE les filtres dans l’URL, et les relit au rechargement', async ({ page }) => {
    await connecte(page);
    await mockApi(page, {
      items: [message(), message({ id: ID_CRITIQUE, importance: 'critique' })],
    });

    await page.goto('/messages');
    await page.getByRole('button', { name: /À traiter d'abord/ }).click();

    await expect(page).toHaveURL(/importance=critique/);
    await page.reload();
    await expect(page.getByRole('button', { name: /À traiter d'abord/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('télécharge une pièce jointe par son IDENTIFIANT, jamais par un chemin', async ({
    page,
  }) => {
    await connecte(page);
    await mockApi(page, {
      items: [
        message({
          attachments: [{ id: ID_PIECE, nom: 'capture.png', mime: 'image/png', taille: 2048 }],
        }),
      ],
    });

    await page.goto('/messages');
    await page.getByText('Lire le message').click();

    const lien = page.getByRole('link', { name: /capture\.png/ });
    await expect(lien).toHaveAttribute('href', `/api/v1/messages/pieces/${ID_PIECE}`);
  });
});

test.describe('Irruption d’un message critique', () => {
  test('s’impose PAR-DESSUS un écran quelconque', async ({ page }) => {
    // La coquille ne se reconstruit pas d'une navigation à l'autre : la
    // fenêtre doit surgir là où l'utilisateur se trouve.
    await connecte(page);
    await mockApi(page, {
      items: [CRITIQUE],
      compteurs: { total: 1, nonLus: 1, interrompt: 1 },
    });

    await page.goto('/historique');

    const fenetre = page.getByRole('dialog');
    await expect(fenetre).toBeVisible();
    await expect(fenetre).toContainText('Coupure de service ce soir');
  });

  test('PREND le focus, et se referme par ÉCHAP', async ({ page }) => {
    await connecte(page);
    await mockApi(page, {
      items: [CRITIQUE],
      compteurs: { total: 1, nonLus: 1, interrompt: 1 },
    });

    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: "J'ai lu" })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('« J’ai lu » MARQUE le message et referme', async ({ page }) => {
    const ouverts: string[] = [];
    await connecte(page);
    await mockApi(page, {
      items: [CRITIQUE],
      compteurs: { total: 1, nonLus: 1, interrompt: 1 },
      ouverts,
    });

    await page.goto('/tableau-de-bord');
    await page.getByRole('button', { name: "J'ai lu" }).click();

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => ouverts).toEqual([ID_CRITIQUE]);
  });

  test('ne s’impose PAS quand rien n’est critique', async ({ page }) => {
    await connecte(page);
    await mockApi(page, { compteurs: { total: 2, nonLus: 2, interrompt: 0 } });

    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('heading').first()).toBeVisible();

    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('Pastille de la barre', () => {
  test('ANNONCE ce qu’elle compte, pas seulement le nombre', async ({ page }) => {
    await connecte(page);
    await mockApi(page, { compteurs: { total: 5, nonLus: 3, interrompt: 0 } });

    await page.goto('/tableau-de-bord');

    await expect(page.getByLabel('3 message(s) non lu(s)')).toHaveText('3');
  });

  test('n’affiche AUCUN nombre quand tout est lu', async ({ page }) => {
    await connecte(page);
    await mockApi(page, { compteurs: { total: 5, nonLus: 0, interrompt: 0 } });

    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('link', { name: 'Messages' })).toBeVisible();

    await expect(page.getByLabel(/message\(s\) non lu\(s\)/)).toBeHidden();
  });
});

test.describe('Composition', () => {
  test('est REFUSÉE à qui n’a pas messages:write', async ({ page }) => {
    await connecte(page);
    await mockApi(page);

    await page.goto('/messages/nouveau');

    await expect(page.getByRole('heading', { name: /refusé/i })).toBeVisible();
  });

  test('ENVOIE réellement le fichier en multipart', async ({ page }) => {
    // Un `FormData` construit en mémoire ne dit rien de ce qui passe sur le
    // fil : c'est la requête réelle qu'on inspecte ici.
    const envois: { champs: Record<string, string>; fichiers: string[] }[] = [];
    await connecte(page, [], 50);
    await mockApi(page, { envois });

    await page.goto('/messages/nouveau');
    await page.getByLabel(/Objet/).fill('Bascule v2 jeudi');
    await page.getByLabel(/^Message/).fill('La bascule est programmée jeudi à 14h.');
    await page.getByLabel(/Pièces jointes/).setInputFiles({
      name: 'capture.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect.poll(() => envois.length).toBe(1);
    expect(envois[0]?.champs['subject']).toBe('Bascule v2 jeudi');
    expect(envois[0]?.champs['audience']).toBe('tous');
    expect(envois[0]?.fichiers).toEqual(['capture.png']);
  });

  test('n’envoie QUE la cible de l’audience choisie', async ({ page }) => {
    const envois: { champs: Record<string, string>; fichiers: string[] }[] = [];
    await connecte(page, [], 50);
    await mockApi(page, { envois });

    await page.goto('/messages/nouveau');
    await page.getByLabel(/Objet/).fill('Consigne aux éditeurs');
    await page.getByLabel(/^Message/).fill('Merci de relire vos profils.');
    await page.getByRole('radio', { name: 'Un rang et au-dessus' }).check();
    await page.getByLabel(/Rang visé/).selectOption('30');
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect.poll(() => envois.length).toBe(1);
    expect(envois[0]?.champs['audienceRank']).toBe('30');
    expect(envois[0]?.champs['recipientIds']).toBeUndefined();
  });

  test('mène au message envoyé, DÉPLIÉ', async ({ page }) => {
    await connecte(page, [], 50);
    await mockApi(page, { envois: [] });

    await page.goto('/messages/nouveau');
    await page.getByLabel(/Objet/).fill('Bascule v2 jeudi');
    await page.getByLabel(/^Message/).fill('La bascule est jeudi à 14h.');
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect(page).toHaveURL(/\/messages\?ouvert=/);
  });
});
