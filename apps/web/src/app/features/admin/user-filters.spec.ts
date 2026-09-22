import { RANKS } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import {
  FILTRES_VIDES,
  filtresActifs,
  filtresDepuisParams,
  filtresVersRequete,
  libelleRang,
  libelleStatut,
  nombreDePages,
  paramsDepuisFiltres,
  rangsAttribuables,
  refusPrevisible,
  TAILLE_PAGE,
  type UserFilterState,
} from './user-filters';

const ACTEUR = { id: 'moi', rank: RANKS.ADMIN };

function cible(over: Partial<{ id: string; rank: number }> = {}) {
  return { id: 'autre', rank: RANKS.TESTER, ...over };
}

describe('lecture des filtres depuis l’URL', () => {
  it('rend les filtres vides sans paramètre', () => {
    expect(filtresDepuisParams({})).toEqual(FILTRES_VIDES);
  });

  it('lit une recherche, un rang et un statut', () => {
    expect(filtresDepuisParams({ recherche: ' ali ', rang: '50', statut: 'suspended' })).toEqual({
      search: 'ali',
      rank: RANKS.ADMIN,
      status: 'suspended',
      page: 1,
    });
  });

  it('IGNORE un rang hors catalogue plutôt que de le transmettre', () => {
    // Le backend le refuserait en 400, et l'utilisateur verrait une erreur
    // pour un lien qu'il n'a pas composé.
    expect(filtresDepuisParams({ rang: '42' }).rank).toBeNull();
    expect(filtresDepuisParams({ rang: 'admin' }).rank).toBeNull();
    expect(filtresDepuisParams({ rang: '' }).rank).toBeNull();
  });

  it('IGNORE un statut inconnu', () => {
    expect(filtresDepuisParams({ statut: 'zombie' }).status).toBe('');
  });

  it('retombe sur la page 1 devant une pagination illisible', () => {
    for (const page of ['0', '-3', '2.5', 'deux', '']) {
      expect(filtresDepuisParams({ page }).page).toBe(1);
    }
    expect(filtresDepuisParams({ page: '4' }).page).toBe(4);
  });
});

describe('écriture des filtres dans l’URL', () => {
  it('OMET les valeurs par défaut', () => {
    // Deux états identiques doivent produire la même adresse, sans quoi
    // « Précédent » fait défiler des doublons.
    expect(paramsDepuisFiltres(FILTRES_VIDES)).toEqual({});
  });

  it('écrit ce qui est renseigné', () => {
    const filtres: UserFilterState = {
      search: 'ali',
      rank: RANKS.ADMIN,
      status: 'active',
      page: 3,
    };
    expect(paramsDepuisFiltres(filtres)).toEqual({
      recherche: 'ali',
      rang: '50',
      statut: 'active',
      page: '3',
    });
  });

  it('fait l’aller-retour sans rien perdre', () => {
    const filtres: UserFilterState = {
      search: 'bob',
      rank: RANKS.TESTER,
      status: 'pending',
      page: 2,
    };
    expect(filtresDepuisParams(paramsDepuisFiltres(filtres))).toEqual(filtres);
  });

  it('écrit le rang 10, qui n’est pas une absence de filtre', () => {
    // `RANKS.TESTER` est falsy-adjacent dans bien des écritures naïves : une
    // omission le perdrait et afficherait tous les comptes.
    expect(paramsDepuisFiltres({ ...FILTRES_VIDES, rank: RANKS.TESTER })).toEqual({ rang: '10' });
  });
});

describe('traduction en requête API', () => {
  it('convertit la page en décalage', () => {
    expect(filtresVersRequete({ ...FILTRES_VIDES, page: 3 })).toEqual({
      limit: TAILLE_PAGE,
      offset: TAILLE_PAGE * 2,
    });
  });

  it('n’envoie que les filtres renseignés', () => {
    expect(filtresVersRequete({ search: 'ali', rank: null, status: 'active', page: 1 })).toEqual({
      limit: TAILLE_PAGE,
      offset: 0,
      search: 'ali',
      status: 'active',
    });
  });
});

describe('état des filtres', () => {
  it('reconnaît l’absence de filtre', () => {
    expect(filtresActifs(FILTRES_VIDES)).toBe(false);
    // Une page autre que la première n'est pas un filtre : l'écran ne doit pas
    // proposer « effacer les filtres » à qui a seulement tourné la page.
    expect(filtresActifs({ ...FILTRES_VIDES, page: 4 })).toBe(false);
  });

  it('reconnaît chaque filtre, pris isolément', () => {
    expect(filtresActifs({ ...FILTRES_VIDES, search: 'a' })).toBe(true);
    expect(filtresActifs({ ...FILTRES_VIDES, rank: RANKS.TESTER })).toBe(true);
    expect(filtresActifs({ ...FILTRES_VIDES, status: 'active' })).toBe(true);
  });

  it('compte au moins une page, même sans résultat', () => {
    expect(nombreDePages(0)).toBe(1);
    expect(nombreDePages(TAILLE_PAGE)).toBe(1);
    expect(nombreDePages(TAILLE_PAGE + 1)).toBe(2);
  });
});

describe('anticipation des garde-fous', () => {
  it('laisse passer un geste permis', () => {
    expect(refusPrevisible(cible(), ACTEUR, 'modifier')).toBeNull();
    expect(refusPrevisible(cible(), ACTEUR, 'supprimer')).toBeNull();
  });

  it('REFUSE de modifier ou supprimer son propre compte', () => {
    expect(refusPrevisible(cible({ id: 'moi' }), ACTEUR, 'modifier')).toMatch(/propre rang/);
    expect(refusPrevisible(cible({ id: 'moi' }), ACTEUR, 'supprimer')).toMatch(/propre compte/);
  });

  it('AUTORISE de changer son propre mot de passe', () => {
    // Le backend ne l'interdit pas : seuls le rang et le statut sont
    // verrouillés sur soi-même.
    expect(refusPrevisible(cible({ id: 'moi' }), ACTEUR, 'motDePasse')).toBeNull();
  });

  it('REFUSE d’agir sur un rang supérieur OU ÉGAL', () => {
    expect(refusPrevisible(cible({ rank: RANKS.SUPER_ADMIN }), ACTEUR, 'modifier')).toMatch(
      /rang supérieur/,
    );
    expect(refusPrevisible(cible({ rank: RANKS.ADMIN }), ACTEUR, 'supprimer')).toMatch(
      /rang supérieur/,
    );
  });

  it('laisse le super_admin agir sur un pair', () => {
    const patron = { id: 'patron', rank: RANKS.SUPER_ADMIN };
    expect(refusPrevisible(cible({ rank: RANKS.SUPER_ADMIN }), patron, 'modifier')).toBeNull();
  });

  it('n’attribue jamais un rang supérieur ou égal au sien', () => {
    expect(rangsAttribuables(RANKS.ADMIN)).toEqual([RANKS.TESTER, RANKS.EDITOR]);
    expect(rangsAttribuables(RANKS.TESTER)).toEqual([]);
  });

  it('laisse le super_admin attribuer tous les rangs, y compris le sien', () => {
    expect(rangsAttribuables(RANKS.SUPER_ADMIN)).toEqual([
      RANKS.TESTER,
      RANKS.EDITOR,
      RANKS.ADMIN,
      RANKS.SUPER_ADMIN,
    ]);
  });
});

describe('libellés', () => {
  it('nomme chaque rang', () => {
    expect(libelleRang(RANKS.SUPER_ADMIN)).toBe('Super administrateur');
    expect(libelleRang(RANKS.ADMIN)).toBe('Administrateur');
    expect(libelleRang(RANKS.EDITOR)).toBe('Éditeur');
    expect(libelleRang(RANKS.TESTER)).toBe('Testeur');
  });

  it('nomme chaque statut', () => {
    expect(libelleStatut('active')).toBe('Actif');
    expect(libelleStatut('suspended')).toBe('Suspendu');
    expect(libelleStatut('pending')).toBe('En attente');
  });
});
