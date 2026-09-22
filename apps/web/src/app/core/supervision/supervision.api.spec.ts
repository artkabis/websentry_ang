import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { SupervisionApi } from './supervision.api';

const BASE = '/api/v1';

function releve(over: Record<string, unknown> = {}) {
  return {
    etat: 'ok',
    releveA: '2026-01-01T10:00:00.000Z',
    instance: { version: '2.0.0', environnement: 'production', uptimeSec: 3600 },
    base: { etat: 'ok', message: 'Connectée, 3 ms.', active: true, latenceMs: 3 },
    poolAnalyse: {
      etat: 'ok',
      message: 'Pool démarré.',
      active: true,
      demarre: true,
      enEchec: false,
      threadsMax: 4,
    },
    retention: { etat: 'ok', message: 'Rien en attente.', active: true, dernierPassage: null },
    volumetrie: { scans24h: 1, scans7j: 2, comptesActifs: 3, retoursOuverts: 0 },
    ...over,
  };
}

describe('SupervisionApi', () => {
  let api: SupervisionApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(SupervisionApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lit le relevé et le valide contre le schéma partagé', async () => {
    const promesse = api.releve();
    const requete = http.expectOne(`${BASE}/supervision`);

    expect(requete.request.method).toBe('GET');
    requete.flush(releve());
    expect((await promesse).base.latenceMs).toBe(3);
  });

  it('accepte une volumétrie absente', async () => {
    const promesse = api.releve();
    http.expectOne(`${BASE}/supervision`).flush(releve({ volumetrie: null }));

    expect((await promesse).volumetrie).toBeNull();
  });

  it('REJETTE une réponse qui dérive du schéma', async () => {
    const promesse = api.releve();
    http.expectOne(`${BASE}/supervision`).flush({ etat: 'ok' });

    await expect(promesse).rejects.toThrow();
  });

  it('REJETTE un champ surnuméraire — la surface est explicite', async () => {
    // Cette réponse décrit l'infrastructure : un champ de trop y serait un
    // renseignement offert, et l'interface doit s'en apercevoir.
    const promesse = api.releve();
    http.expectOne(`${BASE}/supervision`).flush({ ...releve(), hote: 'srv-01' });

    await expect(promesse).rejects.toThrow();
  });

  it('n’expose QUE la lecture', () => {
    // L'API n'offre aucune commande d'exploitation ; ce client n'en invente pas.
    const methodes = Object.getOwnPropertyNames(SupervisionApi.prototype).filter(
      n => n !== 'constructor',
    );
    expect(methodes).toEqual(['releve']);
  });
});
