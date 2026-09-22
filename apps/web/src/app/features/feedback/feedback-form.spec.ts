import { describe, expect, it } from 'vitest';
import {
  BROUILLON_RETOUR_VIDE,
  chargeRetour,
  FILTRES_RETOURS_VIDES,
  filtresRetoursActifs,
  filtresRetoursDepuisParams,
  filtresRetoursVersRequete,
  GRAVITES,
  libelleGravite,
  libelleStatutRetour,
  libelleType,
  nombreDePagesRetours,
  paramsDepuisFiltresRetours,
  problemesRetour,
  retourValide,
  statutsAtteignables,
  STATUTS,
  TAILLE_PAGE_RETOURS,
  TYPES,
  type BrouillonRetour,
  type FeedbackFilterState,
} from './feedback-form';

function brouillon(over: Partial<BrouillonRetour> = {}): BrouillonRetour {
  return {
    ...BROUILLON_RETOUR_VIDE,
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
    ...over,
  };
}

describe('lecture des filtres depuis l’URL', () => {
  it('rend les filtres vides sans paramètre', () => {
    expect(filtresRetoursDepuisParams({})).toEqual(FILTRES_RETOURS_VIDES);
  });

  it('lit statut, type, gravité et recherche', () => {
    expect(
      filtresRetoursDepuisParams({
        statut: 'accepte',
        type: 'suggestion',
        gravite: 'mineur',
        recherche: ' export ',
        page: '2',
      }),
    ).toEqual({
      status: 'accepte',
      kind: 'suggestion',
      severity: 'mineur',
      search: 'export',
      mine: false,
      page: 2,
    });
  });

  it('IGNORE une valeur hors catalogue plutôt que de la transmettre', () => {
    // L'API la refuserait en 400, pour un lien que personne n'a composé.
    expect(filtresRetoursDepuisParams({ statut: 'archive' }).status).toBe('');
    expect(filtresRetoursDepuisParams({ type: 'doleance' }).kind).toBe('');
    expect(filtresRetoursDepuisParams({ gravite: 'critique' }).severity).toBe('');
  });

  it('ne retient « miens » que sur la valeur EXACTE', () => {
    // Un paramètre d'URL est du texte : « false » y serait une chaîne
    // parfaitement vraie, et un test de véracité filtrerait à l'envers.
    expect(filtresRetoursDepuisParams({ miens: 'oui' }).mine).toBe(true);
    for (const valeur of ['false', 'non', '0', 'true', '']) {
      expect(filtresRetoursDepuisParams({ miens: valeur }).mine).toBe(false);
    }
  });

  it('retombe sur la page 1 devant une pagination illisible', () => {
    for (const page of ['0', '-2', '1.5', 'deux', '']) {
      expect(filtresRetoursDepuisParams({ page }).page).toBe(1);
    }
  });
});

describe('écriture des filtres dans l’URL', () => {
  it('OMET les valeurs par défaut', () => {
    expect(paramsDepuisFiltresRetours(FILTRES_RETOURS_VIDES)).toEqual({});
  });

  it('fait l’aller-retour sans rien perdre', () => {
    const filtres: FeedbackFilterState = {
      status: 'en_cours',
      kind: 'bug',
      severity: 'bloquant',
      search: 'score',
      mine: true,
      page: 3,
    };
    expect(filtresRetoursDepuisParams(paramsDepuisFiltresRetours(filtres))).toEqual(filtres);
  });
});

describe('traduction en requête API', () => {
  it('convertit la page en décalage', () => {
    expect(filtresRetoursVersRequete({ ...FILTRES_RETOURS_VIDES, page: 3 })).toEqual({
      limit: TAILLE_PAGE_RETOURS,
      offset: TAILLE_PAGE_RETOURS * 2,
    });
  });

  it('n’envoie « mine » que lorsqu’il est demandé', () => {
    expect(filtresRetoursVersRequete(FILTRES_RETOURS_VIDES)).not.toHaveProperty('mine');
    expect(filtresRetoursVersRequete({ ...FILTRES_RETOURS_VIDES, mine: true }).mine).toBe(true);
  });
});

describe('état des filtres', () => {
  it('ne compte pas la pagination comme un filtre', () => {
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, page: 4 })).toBe(false);
  });

  it('reconnaît chaque filtre, pris isolément', () => {
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, status: 'nouveau' })).toBe(true);
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, kind: 'bug' })).toBe(true);
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, severity: 'majeur' })).toBe(true);
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, search: 'x' })).toBe(true);
    expect(filtresRetoursActifs({ ...FILTRES_RETOURS_VIDES, mine: true })).toBe(true);
  });

  it('compte au moins une page, même sans résultat', () => {
    expect(nombreDePagesRetours(0)).toBe(1);
    expect(nombreDePagesRetours(TAILLE_PAGE_RETOURS + 1)).toBe(2);
  });
});

describe('dépôt d’un retour', () => {
  it('accepte un brouillon complet', () => {
    expect(problemesRetour(brouillon())).toEqual([]);
    expect(retourValide(brouillon())?.kind).toBe('bug');
  });

  it('NOMME le champ fautif dans le message', () => {
    expect(problemesRetour(brouillon({ title: 'bug' }))[0]).toMatch(/^Titre /);
    expect(problemesRetour(brouillon({ body: 'ko' }))[0]).toMatch(/^Description /);
  });

  it('nettoie les espaces de bordure', () => {
    expect(chargeRetour(brouillon({ title: '  Un titre correct  ' }))['title']).toBe(
      'Un titre correct',
    );
  });

  it('n’attache PAS un contexte vide', () => {
    // Un objet de trois nulls n'apprend rien et alourdit la table.
    expect(chargeRetour(brouillon())).not.toHaveProperty('context');
    expect(chargeRetour(brouillon(), { route: null, gamme: null })).not.toHaveProperty('context');
  });

  it('attache le contexte dès qu’il porte quelque chose', () => {
    expect(chargeRetour(brouillon(), { route: '/analyse' })['context']).toEqual({
      route: '/analyse',
      targetUrl: null,
      gamme: null,
    });
  });

  it('REMONTE une URL de contexte invalide avant l’appel réseau', () => {
    expect(problemesRetour(brouillon(), { targetUrl: 'pas-une-url' }).length).toBeGreaterThan(0);
    expect(retourValide(brouillon(), { targetUrl: 'pas-une-url' })).toBeNull();
  });

  it('REFUSE un brouillon vide', () => {
    expect(retourValide(BROUILLON_RETOUR_VIDE)).toBeNull();
    expect(problemesRetour(BROUILLON_RETOUR_VIDE).length).toBeGreaterThan(0);
  });
});

describe('transitions offertes', () => {
  it('n’offre QUE les passages que l’API accepte', () => {
    // Proposer un passage refusé ferait découvrir l'interdit après le clic.
    expect(statutsAtteignables('nouveau')).toEqual(['accepte', 'rejete']);
    expect(statutsAtteignables('en_cours')).toEqual(['resolu', 'rejete']);
  });

  it('n’offre RIEN sur un statut inconnu', () => {
    // Une base écrite par une version plus récente ne doit pas faire proposer
    // un passage au hasard.
    expect(statutsAtteignables('archive')).toEqual([]);
  });

  it('couvre tous les statuts du catalogue', () => {
    for (const statut of STATUTS) {
      expect(statutsAtteignables(statut).length).toBeGreaterThan(0);
    }
  });
});

describe('libellés', () => {
  it.each([
    ['nouveau', 'Nouveau'],
    ['accepte', 'Accepté'],
    ['en_cours', 'En cours'],
    ['resolu', 'Résolu'],
    ['rejete', 'Rejeté'],
  ])('nomme le statut %s', (code, libelle) => {
    expect(libelleStatutRetour(code)).toBe(libelle);
  });

  it.each([
    ['bug', 'Anomalie'],
    ['suggestion', 'Suggestion'],
    ['question', 'Question'],
  ])('nomme le type %s', (code, libelle) => {
    expect(libelleType(code)).toBe(libelle);
  });

  it.each([
    ['bloquant', 'Bloquant'],
    ['majeur', 'Majeur'],
    ['mineur', 'Mineur'],
    ['cosmetique', 'Cosmétique'],
  ])('nomme la gravité %s', (code, libelle) => {
    expect(libelleGravite(code)).toBe(libelle);
  });

  it('rend le code BRUT pour une valeur inconnue', () => {
    // Masquer une valeur non traduite la rendrait invisible.
    expect(libelleStatutRetour('archive')).toBe('archive');
    expect(libelleType('doleance')).toBe('doleance');
    expect(libelleGravite('critique')).toBe('critique');
  });

  it('couvre tout le catalogue, sans code brut résiduel', () => {
    for (const statut of STATUTS) expect(libelleStatutRetour(statut)).not.toBe(statut);
    for (const type of TYPES) expect(libelleType(type)).not.toBe(type);
    for (const gravite of GRAVITES) expect(libelleGravite(gravite)).not.toBe(gravite);
  });
});
