import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { AuditApi } from './audit.api';

const BASE = '/api/v1';

function trace(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    actorId: 'u-1',
    actorName: 'alice',
    action: 'user.create',
    targetId: 'u-2',
    targetType: 'user',
    details: { username: 'bob' },
    ipAddress: '203.0.113.7',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...over,
  };
}

describe('AuditApi', () => {
  let api: AuditApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(AuditApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('n’envoie AUCUN paramètre sans filtre', async () => {
    const promesse = api.list();
    const requete = http.expectOne(`${BASE}/audit`);

    expect(requete.request.params.keys()).toEqual([]);
    requete.flush({ entries: [], total: 0 });
    await promesse;
  });

  it('OMET les filtres vides plutôt que de les envoyer vides', async () => {
    // Le schéma du backend est strict : un `actor=` vide n'exprime aucun
    // filtre, et l'envoyer transformerait « pas de filtre » en « chaîne vide ».
    const promesse = api.list({ actor: 'alice', action: '', from: undefined, limit: 25 });
    const requete = http.expectOne(r => r.url === `${BASE}/audit`);

    expect(requete.request.params.keys().sort()).toEqual(['actor', 'limit']);
    requete.flush({ entries: [], total: 0 });
    await promesse;
  });

  it('envoie un décalage de 0, qui est un filtre légitime', async () => {
    const promesse = api.list({ offset: 0 });
    const requete = http.expectOne(r => r.url === `${BASE}/audit`);

    expect(requete.request.params.get('offset')).toBe('0');
    requete.flush({ entries: [], total: 0 });
    await promesse;
  });

  it('valide la réponse contre le schéma partagé', async () => {
    const promesse = api.list();
    http.expectOne(`${BASE}/audit`).flush({ entries: [trace()], total: 412 });

    const recue = await promesse;
    expect(recue.total).toBe(412);
    expect(recue.entries[0]?.action).toBe('user.create');
  });

  it('REJETTE une réponse qui dérive du schéma', async () => {
    const promesse = api.list();
    http.expectOne(`${BASE}/audit`).flush({ entries: [{ id: 1 }], total: 1 });

    await expect(promesse).rejects.toThrow();
  });

  it('accepte une trace système, sans acteur ni cible', async () => {
    const promesse = api.list();
    http.expectOne(`${BASE}/audit`).flush({
      entries: [trace({ actorId: null, actorName: null, targetId: null, details: null })],
      total: 1,
    });

    expect((await promesse).entries[0]?.actorName).toBeNull();
  });

  it('n’expose QUE la lecture', () => {
    // Le journal est append-only côté serveur : un client qui offrirait une
    // purge donnerait une fausse idée de ce que l'outil garantit.
    const methodes = Object.getOwnPropertyNames(AuditApi.prototype).filter(
      n => n !== 'constructor',
    );
    expect(methodes).toEqual(['list']);
  });
});
