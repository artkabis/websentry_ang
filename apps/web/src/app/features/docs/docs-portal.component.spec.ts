import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { DocIndex, DocPage, DocSearchResponse } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocsApi } from '../../core/docs/docs.api';
import { DocsPortalComponent } from './docs-portal.component';

const RESUME = {
  slug: 'premiers-pas',
  titre: 'Premiers pas',
  section: 'Démarrer',
  ordre: 0,
  resume: 'Lancer une première analyse en trois gestes.',
};

function sommaire(): DocIndex {
  return {
    sections: [
      { section: 'Démarrer', pages: [RESUME] },
      {
        section: 'Gouvernance',
        pages: [
          {
            slug: 'donnees-personnelles',
            titre: 'Données personnelles',
            section: 'Gouvernance',
            ordre: 0,
            resume: 'Ce que l’application conserve.',
          },
        ],
      },
    ],
  };
}

function page(over: Partial<DocPage> = {}): DocPage {
  return {
    ...RESUME,
    blocs: [
      { type: 'titre', niveau: 2, texte: 'Avant de commencer', ancre: 'avant-de-commencer' },
      { type: 'paragraphe', contenu: [{ type: 'texte', texte: 'Il faut un compte actif.' }] },
      { type: 'titre', niveau: 2, texte: 'Lancer l’analyse', ancre: 'lancer-l-analyse' },
    ],
    ...over,
  };
}

function recherche(over: Partial<DocSearchResponse> = {}): DocSearchResponse {
  return {
    q: 'analyse',
    resultats: [{ ...RESUME, extrait: '…une première analyse…', score: 3 }],
    total: 1,
    ...over,
  };
}

/**
 * Laisse l'écran se poser.
 *
 * Deux tours et non un : le premier rend la main aux promesses du double, le
 * second laisse la détection de changements sans zone appliquer les signaux
 * qu'elles viennent d'écrire.
 */
const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

function setup(
  opts: {
    index?: ReturnType<typeof vi.fn>;
    pageApi?: ReturnType<typeof vi.fn>;
    rechercherApi?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const index = opts.index ?? vi.fn().mockResolvedValue(sommaire());
  const pageApi = opts.pageApi ?? vi.fn().mockResolvedValue(page());
  const rechercherApi = opts.rechercherApi ?? vi.fn().mockResolvedValue(recherche());

  return {
    index,
    pageApi,
    rechercherApi,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: DocsApi, useValue: { index, page: pageApi, rechercher: rechercherApi } },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('DocsPortalComponent', () => {
  describe('quatre états du sommaire', () => {
    it('annonce le chargement', async () => {
      const index = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(DocsPortalComponent, { providers: setup({ index }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement du sommaire');
    });

    it('liste les sections une fois chargé', async () => {
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      const nav = screen.getByRole('navigation', { name: "Sommaire de l'aide" });
      expect(within(nav).getByRole('link', { name: 'Premiers pas' })).toBeTruthy();
      expect(within(nav).getByRole('link', { name: 'Données personnelles' })).toBeTruthy();
    });

    it('ORIENTE quand aucune page n’est ouverte', async () => {
      // Un portail vide de contenu n'est pas une erreur : il doit dire quoi
      // faire, pas afficher un blanc.
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      expect(screen.getByRole('status').textContent).toContain('Choisissez une page');
      expect(screen.getByText(/Lancer une première analyse/)).toBeTruthy();
    });

    it('PROPOSE une reprise quand le sommaire échoue', async () => {
      const index = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ index });
      await render(DocsPortalComponent, { providers: t.providers });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('Impossible de charger le sommaire');

      await userEvent.click(within(alerte).getByRole('button', { name: 'Réessayer' }));
      expect(t.index).toHaveBeenCalledTimes(2);
    });
  });

  describe('une page', () => {
    it('affiche son titre et ses blocs', async () => {
      await render(DocsPortalComponent, {
        providers: setup().providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      expect(screen.getByRole('heading', { name: 'Premiers pas' })).toBeTruthy();
      expect(screen.getByText('Il faut un compte actif.')).toBeTruthy();
    });

    it('MARQUE la page courante dans le sommaire', async () => {
      // La couleur seule ne dit pas où l'on est à qui écoute l'écran.
      await render(DocsPortalComponent, {
        providers: setup().providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      const nav = screen.getByRole('navigation', { name: "Sommaire de l'aide" });
      const courant = within(nav).getByRole('link', { name: 'Premiers pas' });
      expect(courant.getAttribute('aria-current')).toBe('page');
    });

    it('offre un sommaire interne dès deux titres', async () => {
      await render(DocsPortalComponent, {
        providers: setup().providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      const surCettePage = screen.getByRole('navigation', { name: 'Sur cette page' });
      // Le lien passe par le routeur : la balise base du document ferait
      // résoudre un « #ancre » nu depuis la racine du site.
      const href = within(surCettePage)
        .getByRole('link', { name: 'Avant de commencer' })
        .getAttribute('href');
      expect(href?.endsWith('#avant-de-commencer')).toBe(true);
    });

    it('N’AFFICHE PAS le sommaire interne pour un seul titre', async () => {
      // Un sommaire d'une entrée n'aide personne et ajoute une tabulation.
      const pageApi = vi.fn().mockResolvedValue(
        page({
          blocs: [{ type: 'titre', niveau: 2, texte: 'Unique', ancre: 'unique' }],
        }),
      );
      await render(DocsPortalComponent, {
        providers: setup({ pageApi }).providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      expect(screen.queryByRole('navigation', { name: 'Sur cette page' })).toBeNull();
    });

    it('DÉPLACE le focus sur le titre en changeant de page, mais pas au premier rendu', async () => {
      // Sans ce déplacement, le clavier resterait dans le sommaire et le
      // lecteur d'écran continuerait d'annoncer la page précédente.
      const pageApi = vi
        .fn()
        .mockImplementation((slug: string) => Promise.resolve(page({ slug, titre: slug })));
      const rendu = await render(DocsPortalComponent, {
        providers: setup({ pageApi }).providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      const premier = screen.getByRole('heading', { name: 'premiers-pas' });
      expect(document.activeElement).not.toBe(premier);

      rendu.fixture.componentRef.setInput('slug', 'profils');
      await tick();

      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'profils' }));
    });

    it('DISTINGUE une page absente d’une panne', async () => {
      // « Réessayer » sur un 404 fait perdre du temps : la sortie est le
      // sommaire, pas une nouvelle tentative.
      const pageApi = vi
        .fn()
        .mockRejectedValue(new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));
      await render(DocsPortalComponent, {
        providers: setup({ pageApi }).providers,
        inputs: { slug: 'inconnue' },
      });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('n’existe pas');
      expect(within(alerte).getByRole('link', { name: 'Revenir au sommaire' })).toBeTruthy();
      expect(within(alerte).queryByRole('button', { name: 'Réessayer' })).toBeNull();
    });

    it('PROPOSE une reprise sur une panne réseau', async () => {
      const pageApi = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ pageApi });
      await render(DocsPortalComponent, {
        providers: t.providers,
        inputs: { slug: 'premiers-pas' },
      });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('Impossible de charger cette page');

      await userEvent.click(within(alerte).getByRole('button', { name: 'Réessayer' }));
      expect(t.pageApi).toHaveBeenCalledTimes(2);
    });
  });

  describe('réponses en retard', () => {
    /** Une promesse dont le test décide du dénouement. */
    function differee<T>(): { promesse: Promise<T>; tenir: (v: T) => void; rompre: () => void } {
      let tenir!: (v: T) => void;
      let rompre!: () => void;
      const promesse = new Promise<T>((resolve, reject) => {
        tenir = resolve;
        rompre = () => reject(new Error('réseau'));
      });
      return { promesse, tenir, rompre };
    }

    it('N’ÉCRASE PAS la page courante avec une réponse plus lente', async () => {
      // Deux clics rapides dans le sommaire : si la première réponse arrive
      // après la seconde, c'est la seconde page qui doit rester à l'écran.
      const lente = differee<DocPage>();
      const pageApi = vi
        .fn()
        .mockReturnValueOnce(lente.promesse)
        .mockResolvedValueOnce(page({ slug: 'profils', titre: 'Profils' }));

      const rendu = await render(DocsPortalComponent, {
        providers: setup({ pageApi }).providers,
        inputs: { slug: 'premiers-pas' },
      });

      rendu.fixture.componentRef.setInput('slug', 'profils');
      await tick();
      expect(screen.getByRole('heading', { name: 'Profils' })).toBeTruthy();

      lente.tenir(page({ slug: 'premiers-pas', titre: 'Premiers pas' }));
      await tick();

      expect(screen.getByRole('heading', { name: 'Profils' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Premiers pas' })).toBeNull();
    });

    it('N’AFFICHE PAS l’échec d’une page qu’on a quittée', async () => {
      // Une erreur sur la page abandonnée effacerait la page qui s'affiche.
      const lente = differee<DocPage>();
      const pageApi = vi
        .fn()
        .mockReturnValueOnce(lente.promesse)
        .mockResolvedValueOnce(page({ slug: 'profils', titre: 'Profils' }));

      const rendu = await render(DocsPortalComponent, {
        providers: setup({ pageApi }).providers,
        inputs: { slug: 'premiers-pas' },
      });

      rendu.fixture.componentRef.setInput('slug', 'profils');
      await tick();

      lente.rompre();
      await tick();

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Profils' })).toBeTruthy();
    });

    it('N’ÉCRASE PAS les résultats avec une recherche plus lente', async () => {
      const lente = differee<DocSearchResponse>();
      const rechercherApi = vi
        .fn()
        .mockReturnValueOnce(lente.promesse)
        .mockResolvedValueOnce(recherche({ q: 'profil', resultats: [], total: 0 }));

      const rendu = await render(DocsPortalComponent, {
        providers: setup({ rechercherApi }).providers,
        inputs: { q: 'analyse' },
      });

      rendu.fixture.componentRef.setInput('q', 'profil');
      await tick();
      expect(screen.getByRole('status').textContent).toContain('Aucune page pour « profil »');

      lente.tenir(recherche());
      await tick();

      expect(screen.getByRole('status').textContent).toContain('Aucune page pour « profil »');
    });

    it('N’AFFICHE PAS l’échec d’une recherche abandonnée', async () => {
      const lente = differee<DocSearchResponse>();
      const rechercherApi = vi
        .fn()
        .mockReturnValueOnce(lente.promesse)
        .mockResolvedValueOnce(recherche({ q: 'profil' }));

      const rendu = await render(DocsPortalComponent, {
        providers: setup({ rechercherApi }).providers,
        inputs: { q: 'analyse' },
      });

      rendu.fixture.componentRef.setInput('q', 'profil');
      await tick();

      lente.rompre();
      await tick();

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('1 page(s) pour « profil »');
    });
  });

  describe('recherche', () => {
    it('affiche les résultats du terme porté par l’URL', async () => {
      const t = setup();
      await render(DocsPortalComponent, { providers: t.providers, inputs: { q: 'analyse' } });
      await tick();

      expect(t.rechercherApi).toHaveBeenCalledWith('analyse');
      // L'extrait vient de l'API, en texte brut : c'est lui qui distingue le
      // résultat du lien homonyme du sommaire, toujours affiché à gauche.
      const resultat = screen.getByText('…une première analyse…').closest('a');
      expect(resultat?.getAttribute('href')).toBe('/aide/premiers-pas');
      expect(screen.getByRole('status').textContent).toContain('1 page(s) pour « analyse »');
    });

    it('SUPPORTE que le routeur pousse un terme absent', async () => {
      // `withComponentInputBinding()` écrit `undefined` dans l'entrée quand le
      // paramètre quitte l'URL : la valeur par défaut d'`input()` ne vaut que
      // pour le premier rendu, et sans ce repli l'écran plantait au second.
      const t = setup();
      const rendu = await render(DocsPortalComponent, {
        providers: t.providers,
        inputs: { q: 'analyse' },
      });
      await tick();

      rendu.fixture.componentRef.setInput('q', undefined);
      await tick();

      expect(screen.getByRole('status').textContent).toContain('Choisissez une page');
      expect(screen.getByRole('searchbox', { name: /Rechercher/ })).toHaveProperty('value', '');
    });

    it('N’APPELLE PAS l’API sous deux caractères', async () => {
      // Le schéma partagé refuse un terme d'un caractère : l'écran le rejoue
      // pour éviter un aller-retour voué au 400, sans s'y substituer.
      const t = setup();
      await render(DocsPortalComponent, { providers: t.providers, inputs: { q: 'a' } });
      await tick();

      expect(t.rechercherApi).not.toHaveBeenCalled();
    });

    it('EXPLIQUE une recherche sans résultat', async () => {
      const rechercherApi = vi.fn().mockResolvedValue(recherche({ resultats: [], total: 0 }));
      await render(DocsPortalComponent, {
        providers: setup({ rechercherApi }).providers,
        inputs: { q: 'zorglub' },
      });
      await tick();

      // L'annonce vocale et la carte ne disent pas la même phrase : la répéter
      // mot pour mot la ferait entendre deux fois.
      expect(screen.getByRole('status').textContent).toContain('Aucune page pour « zorglub »');
      expect(screen.getByText(/n'apparaît nulle part/)).toBeTruthy();
      expect(screen.getByText(/parcourez le sommaire/)).toBeTruthy();
    });

    it('PROPOSE une reprise quand la recherche échoue', async () => {
      const rechercherApi = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ rechercherApi });
      await render(DocsPortalComponent, { providers: t.providers, inputs: { q: 'analyse' } });
      await tick();

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('La recherche n’a pas abouti');

      await userEvent.click(within(alerte).getByRole('button', { name: 'Réessayer' }));
      expect(t.rechercherApi).toHaveBeenCalledTimes(2);
    });

    it('REFLÈTE le terme dans l’URL, une fois la frappe terminée', async () => {
      // Un résultat doit se partager et survivre à un rechargement.
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      const naviguer = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher/ }), 'audit');
      await new Promise(resolve => setTimeout(resolve, 400));

      // Une seule écriture pour cinq caractères : l'historique reste
      // utilisable, et le bouton « précédent » ne remonte pas lettre à lettre.
      expect(naviguer).toHaveBeenCalledTimes(1);
      expect(naviguer.mock.calls[0]?.[1]?.queryParams).toEqual({ q: 'audit' });
    });

    it('EFFACE le terme de l’URL quand le champ redevient trop court', async () => {
      await render(DocsPortalComponent, { providers: setup().providers, inputs: { q: 'audit' } });
      await tick();

      const naviguer = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      await userEvent.clear(screen.getByRole('searchbox', { name: /Rechercher/ }));
      await new Promise(resolve => setTimeout(resolve, 400));

      expect(naviguer.mock.calls[0]?.[1]?.queryParams).toEqual({ q: null });
    });

    it('PRÉVIENT qu’un caractère de plus lancera la recherche', async () => {
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher/ }), 'a');

      expect(screen.getByText(/Encore un caractère/)).toBeTruthy();
    });
  });

  describe('clavier', () => {
    it('met le curseur dans la recherche sur « / »', async () => {
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
      );

      expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: /Rechercher/ }));
    });

    it('NE VOLE PAS la barre oblique à un champ en cours de saisie', async () => {
      // Sans cette réserve, taper une URL ou un chemin deviendrait impossible
      // partout où le raccourci écoute.
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      const champ = screen.getByRole('searchbox', { name: /Rechercher/ });
      const evenement = new KeyboardEvent('keydown', {
        key: '/',
        bubbles: true,
        cancelable: true,
      });
      champ.dispatchEvent(evenement);

      expect(evenement.defaultPrevented).toBe(false);
    });

    it('IGNORE les autres touches', async () => {
      await render(DocsPortalComponent, { providers: setup().providers });
      await tick();

      const evenement = new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(evenement);

      expect(evenement.defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(
        screen.getByRole('searchbox', { name: /Rechercher/ }),
      );
    });
  });
});
