import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { UsageApi } from './usage.api';

const BASE = '/api/v1';

const APERCU = {
  periode: '30j',
  depuis: '2026-01-01T00:00:00.000Z',
  jusqua: '2026-01-31T00:00:00.000Z',
  comptesActifs: 7,
  tunnel: [
    { cle: 'connexion', comptes: 7, actions: 42 },
    { cle: 'analyse', comptes: 5, actions: 130 },
    { cle: 'exploitation', comptes: 3, actions: 9 },
  ],
  parJour: [{ jour: '2026-01-01', connexions: 3, analyses: 12 }],
  gammes: [{ gamme: 'premium', analyses: 80, scoreMoyen: 72.5 }],
};

const REGISTRE = {
  sources: [
    {
      table: 'audit_log',
      finalite: 'Tracer les actions sensibles',
      donnees: ['identifiant de compte'],
      retentionJours: 180,
    },
  ],
  anonymisation: { apresJours: 180, anonymisees: 12, enAttente: 0, dernierPassage: null },
  collecteDediee: false,
};

describe('UsageApi', () => {
  let api: UsageApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(UsageApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('transmet la période demandée', async () => {
    const promesse = api.overview('7j');
    const requete = http.expectOne(r => r.url === `${BASE}/usage`);

    expect(requete.request.params.get('periode')).toBe('7j');
    requete.flush(APERCU);
    await promesse;
  });

  it('valide l’aperçu contre le schéma partagé', async () => {
    const promesse = api.overview('30j');
    http.expectOne(r => r.url === `${BASE}/usage`).flush(APERCU);

    expect((await promesse).comptesActifs).toBe(7);
  });

  it('REJETTE une réponse qui se mettrait à NOMMER quelqu’un', async () => {
    // Le schéma est strict : c'est le garde-fou du module, et il vaut des deux
    // côtés du fil.
    const promesse = api.overview('30j');
    http.expectOne(r => r.url === `${BASE}/usage`).flush({ ...APERCU, acteurs: ['alice', 'bob'] });

    await expect(promesse).rejects.toThrow();
  });

  it('REJETTE une étape de tunnel porteuse d’un nom', async () => {
    const promesse = api.overview('30j');
    http
      .expectOne(r => r.url === `${BASE}/usage`)
      .flush({
        ...APERCU,
        tunnel: [{ cle: 'connexion', comptes: 1, actions: 1, qui: 'alice' }],
      });

    await expect(promesse).rejects.toThrow();
  });

  it('lit le registre de traitement', async () => {
    const promesse = api.governance();
    http.expectOne(`${BASE}/usage/gouvernance`).flush(REGISTRE);

    expect((await promesse).collecteDediee).toBe(false);
  });

  it('REJETTE un registre qui annoncerait une collecte dédiée', async () => {
    const promesse = api.governance();
    http.expectOne(`${BASE}/usage/gouvernance`).flush({ ...REGISTRE, collecteDediee: true });

    await expect(promesse).rejects.toThrow();
  });

  it('n’expose AUCUNE écriture', () => {
    // L'API n'en a pas, pas même un déclenchement de l'anonymisation : un
    // client qui en offrirait laisserait croire à une commande inexistante.
    const methodes = Object.getOwnPropertyNames(UsageApi.prototype);

    expect(methodes.sort()).toEqual(['constructor', 'governance', 'overview']);
  });
});
