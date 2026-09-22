import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { FeedbackApi } from './feedback.api';

const BASE = '/api/v1';
const ID = '11111111-1111-4111-8111-111111111111';

function retour(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: 'bug',
    severity: 'majeur',
    status: 'nouveau',
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
    context: { route: '/profils', targetUrl: null, gamme: null },
    authorId: 'u-1',
    authorName: 'bob',
    assignedTo: null,
    assignedName: null,
    resolution: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

describe('FeedbackApi', () => {
  let api: FeedbackApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(FeedbackApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('n’envoie AUCUN paramètre sans filtre', async () => {
    const promesse = api.list();
    const requete = http.expectOne(`${BASE}/feedback`);

    expect(requete.request.params.keys()).toEqual([]);
    requete.flush({ items: [], total: 0 });
    await promesse;
  });

  it('OMET les filtres vides plutôt que de les envoyer vides', async () => {
    const promesse = api.list({ status: 'nouveau', kind: '', search: undefined, limit: 10 });
    const requete = http.expectOne(r => r.url === `${BASE}/feedback`);

    expect(requete.request.params.keys().sort()).toEqual(['limit', 'status']);
    requete.flush({ items: [], total: 0 });
    await promesse;
  });

  it('transmet « mine » comme un booléen lisible', async () => {
    const promesse = api.list({ mine: true });
    const requete = http.expectOne(r => r.url === `${BASE}/feedback`);

    expect(requete.request.params.get('mine')).toBe('true');
    requete.flush({ items: [], total: 0 });
    await promesse;
  });

  it('envoie un décalage de 0, qui est un filtre légitime', async () => {
    const promesse = api.list({ offset: 0 });
    const requete = http.expectOne(r => r.url === `${BASE}/feedback`);

    expect(requete.request.params.get('offset')).toBe('0');
    requete.flush({ items: [], total: 0 });
    await promesse;
  });

  it('valide la réponse contre le schéma partagé', async () => {
    const promesse = api.list();
    http.expectOne(`${BASE}/feedback`).flush({ items: [retour()], total: 1 });

    expect((await promesse).items[0]?.title).toBe('Le score ne se recalcule pas');
  });

  it('REJETTE une réponse qui dérive du schéma', async () => {
    const promesse = api.list();
    http.expectOne(`${BASE}/feedback`).flush({ items: [{ id: ID }], total: 1 });

    await expect(promesse).rejects.toThrow();
  });

  it('REJETTE un retour portant un champ surnuméraire', async () => {
    // Le schéma est strict : une clé de trop signale une API qui fuit.
    const promesse = api.list();
    http
      .expectOne(`${BASE}/feedback`)
      .flush({ items: [{ ...retour(), authorEmail: 'bob@exemple.fr' }], total: 1 });

    await expect(promesse).rejects.toThrow();
  });

  it('lit les compteurs', async () => {
    const promesse = api.counts();
    http
      .expectOne(`${BASE}/feedback/compteurs`)
      .flush({ nouveau: 2, accepte: 0, en_cours: 1, resolu: 0, rejete: 0 });

    expect((await promesse).nouveau).toBe(2);
  });

  it('dépose un retour', async () => {
    const entree = {
      kind: 'bug' as const,
      severity: 'majeur' as const,
      title: 'Un titre correct',
      body: 'Un corps suffisamment long pour être exploitable.',
    };
    const promesse = api.create(entree);
    const requete = http.expectOne(`${BASE}/feedback`);

    expect(requete.request.method).toBe('POST');
    expect(requete.request.body).toEqual(entree);
    requete.flush(retour());
    await promesse;
  });

  it('trie par PATCH, en n’envoyant que ce qui change', async () => {
    const promesse = api.triage(ID, { status: 'accepte' });
    const requete = http.expectOne(`${BASE}/feedback/${ID}`);

    expect(requete.request.method).toBe('PATCH');
    expect(requete.request.body).toEqual({ status: 'accepte' });
    requete.flush(retour({ status: 'accepte' }));
    await promesse;
  });

  it('n’expose NI suppression NI réécriture', () => {
    // L'API n'en offre pas : un client qui en proposerait donnerait une fausse
    // idée de ce qui est garanti à celui qui dépose un retour.
    const methodes = Object.getOwnPropertyNames(FeedbackApi.prototype).filter(
      n => n !== 'constructor' && n !== 'toParams',
    );
    // Pas de lecture unitaire : la liste porte déjà le retour complet, et une
    // méthode sans appelant est du code spéculatif.
    expect(methodes.sort()).toEqual(['counts', 'create', 'list', 'triage']);
  });
});
