import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { authInterceptor, resetInFlightRefresh } from './auth.interceptor';
import { credentialsInterceptor } from './credentials.interceptor';
import { CSRF_HEADER } from './csrf';
import { csrfInterceptor } from './csrf.interceptor';

const BASE = '/api/v1';
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Pose ou efface le cookie CSRF que l'intercepteur va relire. */
function setCsrfCookie(value: string | null): void {
  document.cookie = value === null ? 'ws_csrf=; max-age=0; path=/' : `ws_csrf=${value}; path=/`;
}

describe('csrfInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([csrfInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    setCsrfCookie('jeton-csrf');
  });

  afterEach(() => {
    backend.verify();
    setCsrfCookie(null);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('joint le jeton sur %s', method => {
    void firstValueFrom(http.request(method, `${BASE}/ressource`, { body: {} }));
    const req = backend.expectOne(`${BASE}/ressource`);
    expect(req.request.headers.get(CSRF_HEADER)).toBe('jeton-csrf');
    req.flush({});
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('ne joint RIEN sur %s — aucun effet de bord', method => {
    void firstValueFrom(http.request(method, `${BASE}/ressource`));
    const req = backend.expectOne(`${BASE}/ressource`);
    expect(req.request.headers.has(CSRF_HEADER)).toBe(false);
    req.flush({});
  });

  it('laisse passer la requête quand aucun cookie CSRF n’existe', () => {
    setCsrfCookie(null);
    void firstValueFrom(http.post(`${BASE}/ressource`, {}));
    const req = backend.expectOne(`${BASE}/ressource`);
    expect(req.request.headers.has(CSRF_HEADER)).toBe(false);
    req.flush({});
  });
});

describe('credentialsInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([credentialsInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
  });

  it('active withCredentials vers l’API', () => {
    void firstValueFrom(http.get(`${BASE}/auth/me`));
    const req = backend.expectOne(`${BASE}/auth/me`);
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
  });

  it('N’ACTIVE PAS withCredentials vers une origine tierce', () => {
    // L'activer globalement enverrait les cookies d'authentification à toute
    // origine contactée par l'application.
    void firstValueFrom(http.get('https://tiers.example/donnees'));
    const req = backend.expectOne('https://tiers.example/donnees');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
  });
});

describe('authInterceptor — renouvellement silencieux', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetInFlightRefresh();
    navigate = vi.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        { provide: Router, useValue: { navigate, url: '/tableau-de-bord' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    resetInFlightRefresh();
  });

  it('laisse passer une réponse réussie sans rien tenter', async () => {
    const promise = firstValueFrom(http.get(`${BASE}/scans`));
    backend.expectOne(`${BASE}/scans`).flush({ items: [] });
    await expect(promise).resolves.toEqual({ items: [] });
  });

  it('tente une rotation sur 401, puis REJOUE la requête', async () => {
    // Sans ce mécanisme, l'utilisateur serait déconnecté toutes les 15 minutes.
    const promise = firstValueFrom(http.get(`${BASE}/scans`));
    backend.expectOne(`${BASE}/scans`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();

    backend.expectOne(`${BASE}/auth/refresh`).flush({ role: 'tester', username: 'alice' });
    await tick();

    backend.expectOne(`${BASE}/scans`).flush({ items: ['rejoue'] });
    await expect(promise).resolves.toEqual({ items: ['rejoue'] });
  });

  it('redirige vers la connexion quand la rotation échoue', async () => {
    const promise = firstValueFrom(http.get(`${BASE}/scans`));
    backend.expectOne(`${BASE}/scans`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();

    backend
      .expectOne(`${BASE}/auth/refresh`)
      .flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();

    await expect(promise).rejects.toBeDefined();
    expect(navigate).toHaveBeenCalledWith(['/connexion'], {
      queryParams: { retour: '/tableau-de-bord' },
    });
  });

  it.each(['/auth/login', '/auth/refresh', '/auth/logout'])(
    'ne tente AUCUNE rotation sur un 401 de %s — cela bouclerait',
    async path => {
      const promise = firstValueFrom(http.post(`${BASE}${path}`, {}));
      backend.expectOne(`${BASE}${path}`).flush(null, { status: 401, statusText: 'Unauthorized' });

      await expect(promise).rejects.toBeDefined();
      backend.expectNone(`${BASE}/auth/refresh`);
    },
  );

  it.each([403, 404, 500])('ne tente aucune rotation sur un %s', async status => {
    const promise = firstValueFrom(http.get(`${BASE}/scans`));
    backend.expectOne(`${BASE}/scans`).flush(null, { status, statusText: 'Erreur' });

    await expect(promise).rejects.toBeDefined();
    backend.expectNone(`${BASE}/auth/refresh`);
  });

  it('PARTAGE une seule rotation entre requêtes concurrentes', async () => {
    // Dix appels simultanés déclencheraient sinon dix rotations, dont neuf
    // invalideraient le jeton obtenu par la première.
    const a = firstValueFrom(http.get(`${BASE}/scans`));
    const b = firstValueFrom(http.get(`${BASE}/users`));

    backend.expectOne(`${BASE}/scans`).flush(null, { status: 401, statusText: 'Unauthorized' });
    backend.expectOne(`${BASE}/users`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();

    // Une SEULE requête de rotation, malgré deux 401.
    const refreshes = backend.match(`${BASE}/auth/refresh`);
    expect(refreshes).toHaveLength(1);
    refreshes[0]!.flush({ role: 'tester', username: 'alice' });
    await tick();

    backend.expectOne(`${BASE}/scans`).flush({ ok: 'scans' });
    backend.expectOne(`${BASE}/users`).flush({ ok: 'users' });

    await expect(a).resolves.toEqual({ ok: 'scans' });
    await expect(b).resolves.toEqual({ ok: 'users' });
  });

  it('autorise une NOUVELLE rotation après la fin de la précédente', async () => {
    const first = firstValueFrom(http.get(`${BASE}/scans`));
    backend.expectOne(`${BASE}/scans`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();
    backend.expectOne(`${BASE}/auth/refresh`).flush({ role: 'tester', username: 'alice' });
    await tick();
    backend.expectOne(`${BASE}/scans`).flush({ ok: 1 });
    await first;

    const second = firstValueFrom(http.get(`${BASE}/users`));
    backend.expectOne(`${BASE}/users`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();
    backend.expectOne(`${BASE}/auth/refresh`).flush({ role: 'tester', username: 'alice' });
    await tick();
    backend.expectOne(`${BASE}/users`).flush({ ok: 2 });
    await expect(second).resolves.toEqual({ ok: 2 });
  });
});
