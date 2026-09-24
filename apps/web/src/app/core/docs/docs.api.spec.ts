import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { DocsApi } from './docs.api';

const BASE = '/api/v1';

const RESUME = {
  slug: 'premiers-pas',
  titre: 'Premiers pas',
  section: 'Démarrer',
  ordre: 0,
  resume: 'Lancer une première analyse.',
};

const SOMMAIRE = { sections: [{ section: 'Démarrer', pages: [RESUME] }] };

const PAGE = {
  ...RESUME,
  blocs: [
    { type: 'titre', niveau: 2, texte: 'Avant de commencer', ancre: 'avant-de-commencer' },
    { type: 'paragraphe', contenu: [{ type: 'texte', texte: 'Il faut un compte.' }] },
  ],
};

const RECHERCHE = {
  q: 'analyse',
  resultats: [{ ...RESUME, extrait: '…analyse…', score: 3 }],
  total: 1,
};

describe('DocsApi', () => {
  let api: DocsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(DocsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lit le sommaire', async () => {
    const promesse = api.index();
    http.expectOne(`${BASE}/docs`).flush(SOMMAIRE);

    expect((await promesse).sections[0]?.pages[0]?.titre).toBe('Premiers pas');
  });

  it('lit une page par son identifiant', async () => {
    const promesse = api.page('premiers-pas');
    http.expectOne(`${BASE}/docs/premiers-pas`).flush(PAGE);

    expect((await promesse).blocs).toHaveLength(2);
  });

  it('ENCODE l’identifiant demandé', async () => {
    // Un identifiant ne peut pas contenir de barre oblique — le schéma le
    // refuse des deux côtés. L'encodage garantit qu'une valeur inattendue
    // reste UN segment d'URL au lieu d'en ouvrir un second.
    const promesse = api.page('a/b');
    const requete = http.expectOne(r => r.url.startsWith(`${BASE}/docs/`));

    expect(requete.request.url).toBe(`${BASE}/docs/a%2Fb`);
    requete.flush(PAGE);
    await promesse;
  });

  it('transmet le terme cherché et la limite', async () => {
    const promesse = api.rechercher('analyse', 5);
    const requete = http.expectOne(r => r.url === `${BASE}/docs/recherche`);

    expect(requete.request.params.get('q')).toBe('analyse');
    expect(requete.request.params.get('limit')).toBe('5');
    requete.flush(RECHERCHE);
    await promesse;
  });

  it('OMET la limite quand elle n’est pas demandée', async () => {
    // Laisser l'API choisir son défaut vaut mieux que le recopier ici : deux
    // valeurs par défaut finissent toujours par diverger.
    const promesse = api.rechercher('analyse');
    const requete = http.expectOne(r => r.url === `${BASE}/docs/recherche`);

    expect(requete.request.params.has('limit')).toBe(false);
    requete.flush(RECHERCHE);
    await promesse;
  });

  it('REJETTE un bloc de type inconnu', async () => {
    // Le rendu n'a de gabarit que pour les types du schéma : un bloc inconnu
    // ne doit pas atteindre le gabarit, il doit échouer ici.
    const promesse = api.page('premiers-pas');
    http
      .expectOne(`${BASE}/docs/premiers-pas`)
      .flush({ ...PAGE, blocs: [{ type: 'html', texte: '<script>alert(1)</script>' }] });

    await expect(promesse).rejects.toThrow();
  });

  it('REJETTE un lien qui ne serait ni interne ni https', async () => {
    const promesse = api.page('premiers-pas');
    http.expectOne(`${BASE}/docs/premiers-pas`).flush({
      ...PAGE,
      blocs: [
        {
          type: 'paragraphe',
          contenu: [{ type: 'lien', texte: 'cliquez', href: 'javascript:alert(1)' }],
        },
      ],
    });

    await expect(promesse).rejects.toThrow();
  });

  it('REJETTE un extrait de recherche porteur de balisage déclaré', async () => {
    const promesse = api.rechercher('analyse');
    http
      .expectOne(r => r.url === `${BASE}/docs/recherche`)
      .flush({
        ...RECHERCHE,
        resultats: [{ ...RESUME, extrait: 'ok', score: 1, html: '<b>x</b>' }],
      });

    await expect(promesse).rejects.toThrow();
  });
});
