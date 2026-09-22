import { describe, expect, it } from 'vitest';
import {
  FILTRES_AUDIT_VIDES,
  filtresAuditActifs,
  filtresAuditDepuisParams,
  filtresAuditVersRequete,
  incoherencesAudit,
  libelleAction,
  paramsDepuisFiltresAudit,
  TAILLE_PAGE_AUDIT,
  type AuditFilterState,
} from './audit-filters';

describe('lecture des filtres du journal', () => {
  it('rend les filtres vides sans paramètre', () => {
    expect(filtresAuditDepuisParams({})).toEqual(FILTRES_AUDIT_VIDES);
  });

  it('lit acteur, action, cible et bornes de date', () => {
    expect(
      filtresAuditDepuisParams({
        acteur: ' alice ',
        action: 'user.',
        cible: 'u-2',
        du: '2026-01-01',
        au: '2026-01-31',
        page: '3',
      }),
    ).toEqual({
      actor: 'alice',
      action: 'user.',
      targetId: 'u-2',
      from: '2026-01-01',
      to: '2026-01-31',
      page: 3,
    });
  });

  it('IGNORE une date mal formée plutôt que de l’envoyer', () => {
    // L'API la refuserait en 400 ; mieux vaut le journal complet qu'une erreur
    // pour un lien tronqué par un partage.
    for (const du of ['01/2026', '2026-1-1', 'hier', '']) {
      expect(filtresAuditDepuisParams({ du }).from).toBe('');
    }
  });

  it('retombe sur la page 1 devant une pagination illisible', () => {
    for (const page of ['0', '-2', '1.5', 'trois']) {
      expect(filtresAuditDepuisParams({ page }).page).toBe(1);
    }
  });
});

describe('écriture des filtres du journal', () => {
  it('OMET les valeurs par défaut', () => {
    expect(paramsDepuisFiltresAudit(FILTRES_AUDIT_VIDES)).toEqual({});
  });

  it('fait l’aller-retour sans rien perdre', () => {
    const filtres: AuditFilterState = {
      actor: 'alice',
      action: 'auth.',
      targetId: 'u-9',
      from: '2026-02-01',
      to: '2026-02-28',
      page: 2,
    };
    expect(filtresAuditDepuisParams(paramsDepuisFiltresAudit(filtres))).toEqual(filtres);
  });
});

describe('traduction en requête API', () => {
  it('convertit la page en décalage', () => {
    expect(filtresAuditVersRequete({ ...FILTRES_AUDIT_VIDES, page: 2 })).toEqual({
      limit: TAILLE_PAGE_AUDIT,
      offset: TAILLE_PAGE_AUDIT,
    });
  });

  it('n’envoie que les filtres renseignés', () => {
    expect(
      filtresAuditVersRequete({ ...FILTRES_AUDIT_VIDES, actor: 'alice', from: '2026-01-01' }),
    ).toEqual({
      limit: TAILLE_PAGE_AUDIT,
      offset: 0,
      actor: 'alice',
      from: '2026-01-01',
    });
  });
});

describe('état des filtres', () => {
  it('ne compte pas la pagination comme un filtre', () => {
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, page: 5 })).toBe(false);
  });

  it('reconnaît chaque filtre, pris isolément', () => {
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, actor: 'a' })).toBe(true);
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, action: 'user.' })).toBe(true);
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, targetId: 'u' })).toBe(true);
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, from: '2026-01-01' })).toBe(true);
    expect(filtresAuditActifs({ ...FILTRES_AUDIT_VIDES, to: '2026-01-01' })).toBe(true);
  });
});

describe('incohérences signalées avant l’appel', () => {
  it('ne signale rien sur un intervalle cohérent', () => {
    expect(
      incoherencesAudit({ ...FILTRES_AUDIT_VIDES, from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual([]);
  });

  it('accepte un intervalle d’un seul jour', () => {
    expect(
      incoherencesAudit({ ...FILTRES_AUDIT_VIDES, from: '2026-01-05', to: '2026-01-05' }),
    ).toEqual([]);
  });

  it('SIGNALE un intervalle inversé', () => {
    // L'API rendrait un résultat vide sans rien expliquer ; mieux vaut le dire
    // avant d'envoyer la requête.
    expect(
      incoherencesAudit({ ...FILTRES_AUDIT_VIDES, from: '2026-02-01', to: '2026-01-01' }),
    ).toHaveLength(1);
  });

  it('ne signale rien quand une seule borne est posée', () => {
    expect(incoherencesAudit({ ...FILTRES_AUDIT_VIDES, from: '2026-02-01' })).toEqual([]);
    expect(incoherencesAudit({ ...FILTRES_AUDIT_VIDES, to: '2026-02-01' })).toEqual([]);
  });
});

describe('libellés d’action', () => {
  it.each([
    ['auth.login', 'Connexion'],
    ['auth.logout', 'Déconnexion'],
    ['auth.refresh', 'Renouvellement de session'],
    ['user.create', 'Compte créé'],
    ['user.update', 'Compte modifié'],
    ['user.delete', 'Compte supprimé'],
    ['user.password_reset', 'Mot de passe réinitialisé'],
    ['user.permission_grant', 'Permission accordée'],
    ['user.permission_revoke', 'Permission révoquée'],
  ])('traduit %s en « %s »', (code, libelle) => {
    // Ces libellés sont ce que lit la personne qui enquête : une traduction
    // fausse égare plus sûrement qu'un code brut.
    expect(libelleAction(code)).toBe(libelle);
  });

  it('rend le code BRUT pour une action inconnue', () => {
    // Masquer une action non traduite la rendrait invisible dans une enquête.
    expect(libelleAction('module.inconnu')).toBe('module.inconnu');
  });
});
