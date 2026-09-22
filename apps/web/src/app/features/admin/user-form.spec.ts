import { PASSWORD_MIN_LENGTH, RANKS, type UserSummary } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import {
  BROUILLON_VIDE,
  brouillonDepuisCompte,
  champsModifies,
  chargeCreation,
  creationValide,
  genererMotDePasse,
  modificationValide,
  problemesCreation,
  problemesModification,
  problemesMotDePasse,
  type BrouillonCompte,
} from './user-form';

function compte(over: Partial<UserSummary> = {}): UserSummary {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'bob',
    displayName: 'Bob Martin',
    email: 'bob@exemple.fr',
    rank: RANKS.TESTER,
    role: 'tester',
    status: 'active',
    lockedUntil: null,
    totalScansLaunched: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function brouillon(over: Partial<BrouillonCompte> = {}): BrouillonCompte {
  return {
    ...BROUILLON_VIDE,
    username: 'nouvelle.recrue',
    password: 'MotDePasseValide!2026',
    rank: RANKS.TESTER,
    ...over,
  };
}

describe('création', () => {
  it('accepte un brouillon complet', () => {
    expect(problemesCreation(brouillon())).toEqual([]);
    expect(creationValide(brouillon())?.username).toBe('nouvelle.recrue');
  });

  it('OMET les champs facultatifs vides plutôt que de les envoyer vides', () => {
    // Le schéma refuse une chaîne vide comme courriel : « pas renseigné »
    // n'est pas « renseigné à vide ».
    expect(chargeCreation(brouillon())).not.toHaveProperty('email');
    expect(chargeCreation(brouillon({ email: '  ' }))).not.toHaveProperty('email');
    expect(chargeCreation(brouillon({ email: ' bob@exemple.fr ' }))['email']).toBe(
      'bob@exemple.fr',
    );
  });

  it('NOMME le champ fautif dans le message', () => {
    // « Invalid input » sans champ oblige à deviner lequel des six corriger.
    expect(problemesCreation(brouillon({ password: 'court' }))[0]).toMatch(/^Mot de passe /);
    expect(problemesCreation(brouillon({ username: 'a' }))[0]).toMatch(/^Identifiant /);
    expect(problemesCreation(brouillon({ email: 'pas-un-courriel' }))[0]).toMatch(/^Courriel /);
  });

  it.each([
    [{ username: 'a' }, /^Identifiant /],
    [{ password: 'court' }, /^Mot de passe /],
    [{ rank: 42 }, /^Rang /],
    [{ email: 'pas-un-courriel' }, /^Courriel /],
    [{ displayName: 'x'.repeat(200) }, /^Nom affiché /],
  ])('NOMME le champ fautif pour %o', (patch, attendu) => {
    expect(problemesCreation(brouillon(patch))[0]).toMatch(attendu);
  });

  it('REFUSE un brouillon sans rang', () => {
    expect(problemesCreation(brouillon({ rank: null })).length).toBeGreaterThan(0);
    expect(creationValide(brouillon({ rank: null }))).toBeNull();
  });

  it('normalise l’identifiant comme le fera l’API', () => {
    expect(creationValide(brouillon({ username: '  NouvelleRecrue  ' }))?.username).toBe(
      'nouvellerecrue',
    );
  });
});

describe('modification partielle', () => {
  it('ne rend RIEN quand rien n’a changé', () => {
    const inchange = brouillonDepuisCompte(compte());
    expect(champsModifies(compte(), inchange)).toEqual({});
    expect(modificationValide(compte(), inchange)).toBeNull();
    expect(problemesModification(compte(), inchange)).toEqual([]);
  });

  it('n’envoie QUE ce qui change', () => {
    // Envoyer tout le formulaire écraserait des valeurs que personne n'a
    // touchées, et la trace d'audit annoncerait des changements fictifs.
    const modifie = { ...brouillonDepuisCompte(compte()), status: 'suspended' };
    expect(champsModifies(compte(), modifie)).toEqual({ status: 'suspended' });
  });

  it('DISTINGUE un champ vidé d’un champ inchangé', () => {
    const vide = { ...brouillonDepuisCompte(compte()), displayName: '   ' };
    expect(champsModifies(compte(), vide)).toEqual({ displayName: null });
  });

  it('ne signale pas un changement quand un champ nul reste vide', () => {
    const sansNom = compte({ displayName: null, email: null });
    const intact = brouillonDepuisCompte(sansNom);
    expect(champsModifies(sansNom, intact)).toEqual({});
  });

  it('ignore un rang non renseigné plutôt que de l’envoyer à null', () => {
    const sansRang = { ...brouillonDepuisCompte(compte()), rank: null };
    expect(champsModifies(compte(), sansRang)).toEqual({});
  });

  it('NOMME le statut fautif', () => {
    const faux = { ...brouillonDepuisCompte(compte()), status: 'zombie' };
    expect(problemesModification(compte(), faux)[0]).toMatch(/^Statut /);
  });

  it('remonte un courriel invalide AVANT l’appel réseau', () => {
    const faux = { ...brouillonDepuisCompte(compte()), email: 'pas-un-courriel' };
    expect(problemesModification(compte(), faux)[0]).toMatch(/^Courriel /);
    expect(modificationValide(compte(), faux)).toBeNull();
  });

  it('accepte un changement de rang et de statut ensemble', () => {
    const promu = {
      ...brouillonDepuisCompte(compte()),
      rank: RANKS.EDITOR,
      status: 'suspended',
    };
    expect(modificationValide(compte(), promu)).toEqual({
      rank: RANKS.EDITOR,
      status: 'suspended',
    });
  });
});

describe('mot de passe', () => {
  it('refuse en deçà du minimum partagé', () => {
    expect(problemesMotDePasse('court', '')).toHaveLength(1);
    expect(problemesMotDePasse('a'.repeat(PASSWORD_MIN_LENGTH), '')).toEqual([]);
  });

  it('signale deux saisies divergentes', () => {
    const secret = 'MotDePasseValide!2026';
    expect(problemesMotDePasse(secret, 'autre chose')).toContain('Les deux saisies diffèrent.');
    expect(problemesMotDePasse(secret, secret)).toEqual([]);
  });

  it('ne réclame pas la confirmation tant qu’elle est vide', () => {
    // Avertir « les saisies diffèrent » dès le premier caractère du champ
    // principal serait une alarme permanente et inutile.
    expect(problemesMotDePasse('MotDePasseValide!2026', '')).toEqual([]);
  });

  describe('génération', () => {
    it('rend la longueur demandée', () => {
      expect(genererMotDePasse(20)).toHaveLength(20);
      expect(genererMotDePasse(64)).toHaveLength(64);
    });

    it('satisfait toujours le schéma partagé', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(problemesMotDePasse(genererMotDePasse(), '')).toEqual([]);
      }
    });

    it('ÉVITE les caractères qui se recopient mal', () => {
      // O/0 et I/l/1 se confondent à la lecture : un mot de passe transmis à
      // l'oral ou recopié d'un écran ne doit pas en contenir.
      const tirage = Array.from({ length: 200 }, () => genererMotDePasse()).join('');
      expect(tirage).not.toMatch(/[O0Il1]/);
    });

    it('ne rend jamais deux fois la même chose', () => {
      const tirages = new Set(Array.from({ length: 100 }, () => genererMotDePasse()));
      expect(tirages.size).toBe(100);
    });

    it('couvre tout l’alphabet, sans trou systématique', () => {
      // Un tirage biaisé — par exemple un modulo non corrigé — laisserait des
      // caractères jamais tirés.
      const tirage = new Set(
        Array.from({ length: 500 }, () => genererMotDePasse())
          .join('')
          .split(''),
      );
      expect(tirage.size).toBeGreaterThan(60);
    });
  });
});
