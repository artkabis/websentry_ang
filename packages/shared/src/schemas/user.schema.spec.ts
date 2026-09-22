import { describe, expect, it } from 'vitest';
import {
  CreateUserSchema,
  GrantPermissionSchema,
  PASSWORD_MIN_LENGTH,
  UpdateUserSchema,
  UserListQuerySchema,
  UsernameSchema,
  UserSummarySchema,
} from './user.schema.js';

const MDP = 'a'.repeat(PASSWORD_MIN_LENGTH);

describe('identifiant', () => {
  it('NORMALISE la casse', () => {
    // « Alice » et « alice » désignent la même personne : laisser les deux
    // coexister rendrait un compte introuvable à qui l'a créé autrement.
    expect(UsernameSchema.parse('  Alice  ')).toBe('alice');
  });

  it('accepte les séparateurs usuels au milieu', () => {
    expect(UsernameSchema.parse('jean-pierre.dupont_2')).toBe('jean-pierre.dupont_2');
  });

  it('REFUSE un identifiant qui commence ou finit par un séparateur', () => {
    // Un identifiant bordé de points ou de tirets se confond à l'œil avec un
    // autre, et se copie mal.
    expect(UsernameSchema.safeParse('-alice').success).toBe(false);
    expect(UsernameSchema.safeParse('alice.').success).toBe(false);
  });

  it('REFUSE ce qui n’est pas un identifiant', () => {
    expect(UsernameSchema.safeParse('al').success).toBe(false);
    expect(UsernameSchema.safeParse('alice bob').success).toBe(false);
    expect(UsernameSchema.safeParse('alice@exemple.fr').success).toBe(false);
    expect(UsernameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('création de compte', () => {
  it('accepte un compte complet', () => {
    const lu = CreateUserSchema.parse({
      username: 'Alice',
      password: MDP,
      rank: 50,
      email: 'alice@exemple.fr',
    });

    expect(lu).toMatchObject({ username: 'alice', rank: 50 });
  });

  it('REFUSE un mot de passe trop court', () => {
    const court = { username: 'alice', password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1), rank: 50 };

    expect(CreateUserSchema.safeParse(court).success).toBe(false);
  });

  it('REFUSE un rang inventé', () => {
    // La table porte une contrainte sur ces valeurs : les laisser passer ici
    // donnerait un code d'erreur SQL à la place d'un message utile.
    expect(CreateUserSchema.safeParse({ username: 'alice', password: MDP, rank: 42 }).success).toBe(
      false,
    );
  });

  it('REFUSE une clé surnuméraire', () => {
    // Première ligne contre l'affectation de masse : `status` ou `tokenVersion`
    // glissés dans la charge utile ne doivent pas atteindre le service.
    const avecExtra = { username: 'alice', password: MDP, rank: 10, status: 'active' };

    expect(CreateUserSchema.safeParse(avecExtra).success).toBe(false);
  });
});

describe('modification de compte', () => {
  it('REFUSE une modification vide', () => {
    // Une requête sans changement produirait une trace d'audit qui ne dit rien.
    expect(UpdateUserSchema.safeParse({}).success).toBe(false);
  });

  it('N’ACCEPTE PAS de mot de passe', () => {
    // Le réinitialiser est un geste distinct, avec sa propre route et sa propre
    // trace : le mêler aux autres champs permettrait de le changer par
    // inadvertance en corrigeant un courriel.
    expect(UpdateUserSchema.safeParse({ password: MDP }).success).toBe(false);
  });

  it('permet d’effacer un nom ou un courriel', () => {
    expect(UpdateUserSchema.parse({ displayName: null, email: null })).toEqual({
      displayName: null,
      email: null,
    });
  });
});

describe('octroi de permission', () => {
  it('vaut pour toutes les gammes par défaut', () => {
    const lu = GrantPermissionSchema.parse({ permission: 'scan:run' });

    expect(lu).toEqual({ permission: 'scan:run', gammes: null, expiresAt: null });
  });

  it('REFUSE une liste de gammes VIDE', () => {
    // Un octroi qui n'accorde rien : personne ne le demande exprès, et le lire
    // comme « toutes » serait l'inverse de ce qu'il dit.
    expect(GrantPermissionSchema.safeParse({ permission: 'scan:run', gammes: [] }).success).toBe(
      false,
    );
  });

  it('REFUSE un code de permission inconnu', () => {
    expect(GrantPermissionSchema.safeParse({ permission: 'tout:faire' }).success).toBe(false);
  });
});

describe('liste des comptes', () => {
  it('borne la pagination et la convertit depuis la chaîne d’URL', () => {
    expect(UserListQuerySchema.parse({ limit: '25', offset: '50' })).toMatchObject({
      limit: 25,
      offset: 50,
    });
  });

  it('REFUSE une page démesurée', () => {
    // Sans plafond, un appel unique ramènerait toute la table.
    expect(UserListQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
  });
});

describe('compte exposé', () => {
  it('N’EXPOSE NI empreinte de mot de passe NI compteur d’échecs', () => {
    // Le schéma est strict : ces champs, s'ils étaient ajoutés par mégarde au
    // service, feraient échouer la validation de la réponse.
    const compte = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'alice',
      displayName: null,
      email: null,
      rank: 50,
      role: 'admin',
      status: 'active',
      lockedUntil: null,
      totalScansLaunched: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(UserSummarySchema.safeParse(compte).success).toBe(true);
    expect(UserSummarySchema.safeParse({ ...compte, passwordHash: 'aa:bb' }).success).toBe(false);
    expect(UserSummarySchema.safeParse({ ...compte, failedLogins: 3 }).success).toBe(false);
  });
});

describe('UserListQuerySchema — rang en chaîne de requête', () => {
  it('accepte un rang transmis en TEXTE, comme dans une URL', () => {
    // Un paramètre d'URL n'est jamais un nombre : sans coercition, `?rank=50`
    // partait en 400 alors que la valeur est parfaitement valide.
    expect(UserListQuerySchema.parse({ rank: '50' })).toMatchObject({ rank: 50 });
  });

  it('refuse un rang hors catalogue, même bien formé', () => {
    expect(() => UserListQuerySchema.parse({ rank: '20' })).toThrow();
  });

  it('refuse un rang qui n’est pas un nombre', () => {
    expect(() => UserListQuerySchema.parse({ rank: 'admin' })).toThrow();
  });
});
