import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PROFILE_EXPORT_VERSION, defaultAnalysisSettings } from '@websentry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { ProfileConflictError, ProfilesApi } from './profiles.api';

const BASE = '/api/v1';

function profileResponse(over: Record<string, unknown> = {}) {
  return {
    profile: 'premium',
    label: 'Premium',
    description: null,
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'alice',
    settings: defaultAnalysisSettings(),
    ...over,
  };
}

describe('ProfilesApi', () => {
  let api: ProfilesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        ProfilesApi,
      ],
    });
    api = TestBed.inject(ProfilesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('validation des réponses', () => {
    it('valide un profil contre le schéma partagé', async () => {
      const promise = api.get('premium');
      http.expectOne(`${BASE}/profiles/premium`).flush(profileResponse());
      await expect(promise).resolves.toMatchObject({ profile: 'premium', version: 2 });
    });

    it('REJETTE une réponse qui dérive du contrat', async () => {
      // Détecté à la frontière, pas trois écrans plus loin.
      const promise = api.get('premium');
      http.expectOne(`${BASE}/profiles/premium`).flush({ profile: 'premium' });
      await expect(promise).rejects.toBeDefined();
    });

    it('valide la liste', async () => {
      const promise = api.list();
      http.expectOne(`${BASE}/profiles`).flush([
        {
          profile: 'default',
          label: 'Défaut',
          description: null,
          version: 1,
          createdAt: 'a',
          updatedAt: 'b',
          updatedBy: null,
        },
      ]);
      await expect(promise).resolves.toHaveLength(1);
    });

    it('valide le registre', async () => {
      const promise = api.registry();
      http.expectOne(`${BASE}/registry`).flush({
        checks: [{ id: 'METAS', title: 'Métas', group: 'SEO' }],
        subChecks: [{ key: 'METAS.title_ok', label: 'Titre correct', checkId: 'METAS' }],
      });
      await expect(promise).resolves.toMatchObject({ checks: [{ id: 'METAS' }] });
    });
  });

  describe('encodage des URL', () => {
    it('encode la gamme dans le chemin', async () => {
      const promise = api.get('premium plus');
      http.expectOne(`${BASE}/profiles/premium%20plus`).flush(profileResponse());
      await promise;
    });

    it('encode une gamme contenant des caractères de chemin', async () => {
      // Le serveur normalise de toute façon ; l'encodage évite qu'un segment
      // supplémentaire ne change la route appelée.
      const promise = api.get('a/b');
      http.expectOne(`${BASE}/profiles/a%2Fb`).flush(profileResponse());
      await promise;
    });
  });

  describe('conflit de version', () => {
    it('TRADUIT un 409 en erreur typée, exploitable par l’interface', async () => {
      const promise = api.save('premium', { settings: defaultAnalysisSettings() });
      http.expectOne(`${BASE}/profiles/premium`).flush(
        {
          statusCode: 409,
          error: 'Conflit de version',
          message: 'Modifié entre-temps',
          details: { currentVersion: 5, expectedVersion: 2 },
        },
        { status: 409, statusText: 'Conflict' },
      );

      const err = await promise.catch(e => e);
      expect(err).toBeInstanceOf(ProfileConflictError);
      expect((err as ProfileConflictError).currentVersion).toBe(5);
      expect((err as ProfileConflictError).expectedVersion).toBe(2);
    });

    it('relaie un 409 SANS détails exploitables tel quel', async () => {
      // Inventer des versions serait pire que de remonter l'erreur brute.
      const promise = api.save('premium', { settings: defaultAnalysisSettings() });
      http
        .expectOne(`${BASE}/profiles/premium`)
        .flush(
          { statusCode: 409, error: 'Conflit', message: 'x' },
          { status: 409, statusText: 'Conflict' },
        );

      const err = await promise.catch(e => e);
      expect(err).not.toBeInstanceOf(ProfileConflictError);
    });

    it.each([403, 500, 503])('relaie un %s sans le transformer', async status => {
      const promise = api.save('premium', { settings: defaultAnalysisSettings() });
      http.expectOne(`${BASE}/profiles/premium`).flush(null, { status, statusText: 'Erreur' });

      const err = await promise.catch(e => e);
      expect(err).not.toBeInstanceOf(ProfileConflictError);
    });

    it('traduit aussi un conflit à l’import', async () => {
      const payload = {
        formatVersion: PROFILE_EXPORT_VERSION as 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        profile: 'premium',
        label: 'Premium',
        description: null,
        sourceVersion: 1,
        settings: defaultAnalysisSettings(),
      };
      const promise = api.importProfile('start', payload, 1);
      http.expectOne(`${BASE}/profiles/start/import`).flush(
        {
          statusCode: 409,
          error: 'Conflit',
          message: 'x',
          details: { currentVersion: 3, expectedVersion: 1 },
        },
        { status: 409, statusText: 'Conflict' },
      );

      await expect(promise).rejects.toBeInstanceOf(ProfileConflictError);
    });
  });

  describe('écriture', () => {
    it('transmet la version attendue', async () => {
      const promise = api.save('premium', {
        settings: defaultAnalysisSettings(),
        expectedVersion: 4,
      });
      const req = http.expectOne(`${BASE}/profiles/premium`);
      expect(req.request.method).toBe('PUT');
      expect((req.request.body as { expectedVersion: number }).expectedVersion).toBe(4);
      req.flush(profileResponse());
      await promise;
    });

    it('omet expectedVersion à l’import quand aucune n’est fournie', async () => {
      const payload = {
        formatVersion: PROFILE_EXPORT_VERSION as 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        profile: 'premium',
        label: 'Premium',
        description: null,
        sourceVersion: 1,
        settings: defaultAnalysisSettings(),
      };
      const promise = api.importProfile('start', payload);
      const req = http.expectOne(`${BASE}/profiles/start/import`);
      expect(req.request.body).not.toHaveProperty('expectedVersion');
      req.flush(profileResponse({ profile: 'start' }));
      await promise;
    });

    it('supprime un profil', async () => {
      const promise = api.remove('premium');
      const req = http.expectOne(`${BASE}/profiles/premium`);
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
      await promise;
    });

    it('réinitialise un profil', async () => {
      const promise = api.reset('premium');
      http.expectOne(`${BASE}/profiles/premium/reset`).flush(profileResponse());
      await expect(promise).resolves.toMatchObject({ profile: 'premium' });
    });
  });

  describe('export', () => {
    it('valide l’enveloppe reçue', async () => {
      const promise = api.exportProfile('premium');
      http.expectOne(`${BASE}/profiles/premium/export`).flush({
        formatVersion: PROFILE_EXPORT_VERSION,
        exportedAt: '2026-01-01T00:00:00.000Z',
        profile: 'premium',
        label: 'Premium',
        description: null,
        sourceVersion: 3,
        settings: defaultAnalysisSettings(),
      });
      await expect(promise).resolves.toMatchObject({ sourceVersion: 3 });
    });

    it('refuse une enveloppe d’un format inconnu', async () => {
      const promise = api.exportProfile('premium');
      http.expectOne(`${BASE}/profiles/premium/export`).flush({
        formatVersion: 99,
        exportedAt: 'x',
        profile: 'premium',
        label: 'P',
        description: null,
        sourceVersion: 1,
        settings: defaultAnalysisSettings(),
      });
      await expect(promise).rejects.toBeDefined();
    });
  });

  describe('réglages globaux', () => {
    it('lit le profil de repli', async () => {
      const promise = api.settings();
      http.expectOne(`${BASE}/settings`).flush(profileResponse({ profile: 'default' }));
      await expect(promise).resolves.toMatchObject({ profile: 'default' });
    });
  });
});
