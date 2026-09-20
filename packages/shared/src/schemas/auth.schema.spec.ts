import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AuthSessionSchema,
  CurrentUserSchema,
  GrantedPermissionSchema,
  LoginSchema,
  PermissionCodeSchema,
  RankSchema,
  RoleSchema,
} from './auth.schema.js';
import { HealthSchema } from './health.schema.js';
import { PERMISSIONS, RANKS } from '../types/rbac.js';

/**
 * Ces schémas sont le CONTRAT partagé : le backend les impose à la frontière
 * HTTP, le frontend valide les réponses avec. Les tester ici vérifie la forme
 * elle-même — les tests de l'API vérifient, eux, le comportement des endpoints.
 */

describe('LoginSchema', () => {
  it('accepte des identifiants valides', () => {
    expect(LoginSchema.safeParse({ username: 'alice', password: 'motdepasse' }).success).toBe(true);
  });

  it('supprime les espaces autour de l’identifiant', () => {
    const result = LoginSchema.parse({ username: '  alice  ', password: 'x' });
    expect(result.username).toBe('alice');
  });

  it('REJETTE toute clé surnuméraire — première barrière anti-mass-assignment', () => {
    const result = LoginSchema.safeParse({ username: 'alice', password: 'x', rank: 100 });
    expect(result.success).toBe(false);
  });

  it.each([
    [{}, 'corps vide'],
    [{ username: 'alice' }, 'mot de passe absent'],
    [{ username: '', password: 'x' }, 'identifiant vide'],
    [{ username: 'a'.repeat(65), password: 'x' }, 'identifiant trop long'],
    [{ username: 'alice', password: 'x'.repeat(257) }, 'mot de passe trop long'],
    [{ username: 123, password: 'x' }, 'identifiant non textuel'],
  ])('refuse %#  (%s)', (body, _label) => {
    expect(LoginSchema.safeParse(body).success).toBe(false);
  });

  it('accepte les bornes exactes', () => {
    const result = LoginSchema.safeParse({
      username: 'a'.repeat(64),
      password: 'x'.repeat(256),
    });
    expect(result.success).toBe(true);
  });
});

describe('RankSchema', () => {
  it.each([...Object.values(RANKS)])('accepte le rang %s', rank => {
    expect(RankSchema.safeParse(rank).success).toBe(true);
  });

  it.each([0, 20, 51, 99, 101, -10])('refuse le rang hors contrainte %s', rank => {
    // Le jeu de rangs est fermé côté base (CHECK), il doit l'être ici aussi.
    expect(RankSchema.safeParse(rank).success).toBe(false);
  });

  it('refuse un rang non entier', () => {
    expect(RankSchema.safeParse(50.5).success).toBe(false);
  });
});

describe('RoleSchema', () => {
  it.each(['tester', 'editor', 'admin', 'super_admin'])('accepte %s', role => {
    expect(RoleSchema.safeParse(role).success).toBe(true);
  });

  it('refuse un rôle inventé', () => {
    expect(RoleSchema.safeParse('root').success).toBe(false);
  });
});

describe('PermissionCodeSchema', () => {
  it('accepte tous les codes du catalogue', () => {
    for (const code of Object.values(PERMISSIONS)) {
      expect(PermissionCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('refuse un code hors catalogue', () => {
    expect(PermissionCodeSchema.safeParse('users:destroy').success).toBe(false);
  });
});

describe('GrantedPermissionSchema', () => {
  it('accepte un scope de gammes', () => {
    const result = GrantedPermissionSchema.safeParse({
      permission: PERMISSIONS.DOCS_READ,
      gammes: ['premium'],
    });
    expect(result.success).toBe(true);
  });

  it('accepte un scope ouvert', () => {
    expect(
      GrantedPermissionSchema.safeParse({ permission: PERMISSIONS.DOCS_READ, gammes: null })
        .success,
    ).toBe(true);
  });

  it('exige le champ gammes — son absence rendrait le scope ambigu', () => {
    expect(GrantedPermissionSchema.safeParse({ permission: PERMISSIONS.DOCS_READ }).success).toBe(
      false,
    );
  });
});

describe('AuthSessionSchema', () => {
  it('accepte la réponse minimale de connexion', () => {
    expect(AuthSessionSchema.safeParse({ role: 'admin', username: 'alice' }).success).toBe(true);
  });

  it('REJETTE un jeton glissé dans la réponse — ils vivent en cookies httpOnly', () => {
    const result = AuthSessionSchema.safeParse({
      role: 'admin',
      username: 'alice',
      accessToken: 'eyJ...',
    });
    expect(result.success).toBe(false);
  });
});

describe('CurrentUserSchema', () => {
  const profile = {
    id: 'u1',
    username: 'alice',
    rank: RANKS.ADMIN,
    role: 'admin',
    status: 'active',
    permissions: [],
  };

  it('accepte un profil conforme', () => {
    expect(CurrentUserSchema.safeParse(profile).success).toBe(true);
  });

  it('accepte un identifiant nul', () => {
    expect(CurrentUserSchema.safeParse({ ...profile, id: null }).success).toBe(true);
  });

  it.each(['password_hash', 'token_version', 'failed_logins', 'locked_until', 'email'])(
    'REJETTE le champ sensible %s',
    field => {
      // La liste blanche de sortie est vérifiée ici aussi : si un jour le
      // backend élargissait sa projection, le contrat le refuserait.
      const result = CurrentUserSchema.safeParse({ ...profile, [field]: 'valeur' });
      expect(result.success).toBe(false);
    },
  );

  it.each(['active', 'suspended', 'pending'])('accepte le statut %s', status => {
    expect(CurrentUserSchema.safeParse({ ...profile, status }).success).toBe(true);
  });

  it('refuse un statut inconnu', () => {
    expect(CurrentUserSchema.safeParse({ ...profile, status: 'deleted' }).success).toBe(false);
  });
});

describe('ApiErrorSchema', () => {
  it('accepte la forme d’erreur unifiée', () => {
    const result = ApiErrorSchema.safeParse({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Non authentifié',
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('tolère l’absence d’identifiant de corrélation', () => {
    expect(
      ApiErrorSchema.safeParse({ statusCode: 500, error: 'Erreur', message: 'Panne' }).success,
    ).toBe(true);
  });

  it('REJETTE une stack trace — elle ne doit jamais franchir la frontière HTTP', () => {
    const result = ApiErrorSchema.safeParse({
      statusCode: 500,
      error: 'Erreur',
      message: 'Panne',
      stack: 'Error: ...\n    at /srv/app.js:1',
    });
    expect(result.success).toBe(false);
  });
});

describe('HealthSchema', () => {
  it('accepte la réponse de sonde', () => {
    expect(HealthSchema.safeParse({ ok: true, version: '2.0.0' }).success).toBe(true);
  });

  it('refuse ok à false — la sonde ne répond que si le serveur va bien', () => {
    expect(HealthSchema.safeParse({ ok: false, version: '2.0.0' }).success).toBe(false);
  });

  it('rejette tout champ d’infrastructure supplémentaire', () => {
    expect(HealthSchema.safeParse({ ok: true, version: '2.0.0', hostname: 'srv-01' }).success).toBe(
      false,
    );
  });
});
