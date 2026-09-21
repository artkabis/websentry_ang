import { RANKS, SseBatchEventSchema, type SseBatchEvent } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

/**
 * Flux d'analyse — ce qui arrive VRAIMENT sur le fil.
 *
 * Les suites de sécurité vérifient qui a le droit d'ouvrir ces routes et ce
 * qu'elles refusent. Elles ne disent rien de leur raison d'être : émettre les
 * résultats AU FIL DE L'EAU. Un lot qui n'enverrait ses pages qu'à la fin
 * passerait tous les contrôles d'accès et raterait l'essentiel.
 */

const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};

const PAGE_HTML = `<html lang="fr"><head>
  <title>Boulangerie artisanale à Lyon — pains au levain</title>
  <meta name="description" content="Notre boulangerie artisanale lyonnaise propose des pains au levain naturel, viennoiseries et pâtisseries préparés chaque matin sur place.">
</head><body><h1>Boulangerie</h1><p>${'contenu '.repeat(200)}</p></body></html>`;

/**
 * Événements d'un flux SSE, dans l'ordre d'arrivée.
 *
 * Chaque événement est VALIDÉ contre le contrat partagé : le test vérifie donc
 * aussi que le serveur émet ce que le paquet partagé promet, et non seulement
 * du JSON qui ressemble à ce qu'on attend.
 */
function eventsOf(body: string): SseBatchEvent[] {
  return body
    .split('\n\n')
    .map(block => block.split('\n').find(line => line.startsWith('data:')))
    .filter((line): line is string => Boolean(line))
    .map(line => SseBatchEventSchema.parse(JSON.parse(line.slice('data:'.length).trim())));
}

describe('Flux d’analyse (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN]);
    http = request(t.app.getHttpServer());
    t.db.pages.set('https://exemple.fr/', PAGE_HTML);
    t.db.pages.set('https://exemple.fr/contact', PAGE_HTML);
  });

  afterEach(async () => {
    await t.close();
  });

  async function admin() {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, csrf: cookieValue(cookies, COOKIES.CSRF)! };
  }

  function post(path: string, auth: { cookies: string[]; csrf: string }) {
    return http.post(t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  describe('lot en flux', () => {
    it('émet une page DÈS qu’elle est terminée, puis un récapitulatif', async () => {
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/', 'https://exemple.fr/contact'] })
        .expect(200);

      const events = eventsOf(res.text);
      expect(events.map(event => event.type)).toEqual(['start', 'page', 'page', 'complete']);
    });

    it('porte le RAPPORT de chaque page sur le fil', async () => {
      // Sans cela, l'écran devrait redemander chaque rapport une fois le lot
      // fini — c'est-à-dire attendre la fin, ce que le flux existe pour éviter.
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/'] })
        .expect(200);

      const page = eventsOf(res.text).find(event => event.type === 'page');
      expect(page?.url).toBe('https://exemple.fr/');
      expect(page?.ok).toBe(true);
      expect(Object.keys(page?.report?.checks ?? {}).length).toBeGreaterThan(0);
    });

    it('annonce le MÊME identifiant de lot sur tous ses événements', async () => {
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/'] })
        .expect(200);

      const ids = new Set(eventsOf(res.text).map(event => event.batchId));
      expect(ids.size).toBe(1);
    });

    it('POURSUIT le lot quand une page échoue', async () => {
      // Analyser cinquante pages et tout perdre parce que la douzième ne répond
      // pas serait absurde : chaque page porte son propre sort.
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/introuvable', 'https://exemple.fr/'] })
        .expect(200);

      const events = eventsOf(res.text);
      const pages = events.filter(event => event.type === 'page');
      const final = events.at(-1);

      expect(pages.map(page => page.ok).sort()).toEqual([false, true]);
      expect(final).toMatchObject({ type: 'complete', succeeded: 1, failed: 1 });
    });

    it('ne compte QU’UNE FOIS une adresse répétée', async () => {
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/', 'https://exemple.fr/'] })
        .expect(200);

      const events = eventsOf(res.text);
      expect(events.filter(event => event.type === 'page')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'complete', total: 1 });
    });

    it('sert le flux avec les en-têtes qui EMPÊCHENT le tamponnage', async () => {
      // Un proxy qui tamponne rend la progression d'un bloc à la fin : c'est
      // exactement ce que le flux existe pour éviter.
      const auth = await admin();

      const res = await post('/analyze/batch/stream', auth)
        .send({ urls: ['https://exemple.fr/'] })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['x-accel-buffering']).toBe('no');
    });
  });
});
