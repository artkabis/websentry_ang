import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  RANKS,
  VALID_RANKS,
  canActOnUser,
  canAssignRank,
  defaultPermissionsForRank,
  rankHasPermission,
  rankToRole,
  roleToRank,
  unauthorizedPermissions,
} from './rbac.js';

describe('conversion rang ↔ rôle', () => {
  it.each([
    [RANKS.TESTER, 'tester'],
    [RANKS.EDITOR, 'editor'],
    [RANKS.ADMIN, 'admin'],
    [RANKS.SUPER_ADMIN, 'super_admin'],
  ] as const)('rankToRole(%s) = %s', (rank, role) => {
    expect(rankToRole(rank)).toBe(role);
  });

  it('classe un rang intermédiaire au palier atteint, jamais au-dessus', () => {
    expect(rankToRole(49)).toBe('editor');
    expect(rankToRole(99)).toBe('admin');
  });

  it('classe un rang inférieur au plancher comme tester', () => {
    expect(rankToRole(0)).toBe('tester');
    expect(rankToRole(-10)).toBe('tester');
  });

  it.each(['tester', 'editor', 'admin', 'super_admin'] as const)(
    'roleToRank puis rankToRole est stable pour %s',
    role => {
      expect(rankToRole(roleToRank(role))).toBe(role);
    },
  );

  it('n’expose que les rangs contraints par la base', () => {
    expect([...VALID_RANKS].sort((a, b) => a - b)).toEqual([10, 30, 50, 100]);
  });
});

describe('permissions par défaut', () => {
  it('accorde tout au super_admin', () => {
    expect(defaultPermissionsForRank(RANKS.SUPER_ADMIN)).toEqual(ALL_PERMISSIONS);
  });

  it('n’accorde PAS audit:read à l’admin — réservé au rang 100', () => {
    expect(defaultPermissionsForRank(RANKS.ADMIN)).not.toContain(PERMISSIONS.AUDIT_READ);
  });

  it('n’accorde PAS history:read au tester', () => {
    expect(defaultPermissionsForRank(RANKS.TESTER)).not.toContain(PERMISSIONS.HISTORY_READ);
  });

  it('accorde scan:run dès le rang tester', () => {
    expect(defaultPermissionsForRank(RANKS.TESTER)).toContain(PERMISSIONS.SCAN_RUN);
  });

  it('rend une liste vide sous le plancher', () => {
    expect(defaultPermissionsForRank(0)).toEqual([]);
  });

  it('retient le palier le plus élevé atteint', () => {
    expect(defaultPermissionsForRank(99)).toEqual(defaultPermissionsForRank(RANKS.ADMIN));
  });
});

describe('rankHasPermission', () => {
  it('reflète les défauts du rang', () => {
    expect(rankHasPermission(RANKS.ADMIN, PERMISSIONS.USERS_WRITE)).toBe(true);
    expect(rankHasPermission(RANKS.TESTER, PERMISSIONS.USERS_WRITE)).toBe(false);
  });

  it('refuse un code inconnu', () => {
    expect(rankHasPermission(RANKS.SUPER_ADMIN, 'inexistant:code')).toBe(false);
  });
});

describe('gardes anti-escalade', () => {
  it('interdit d’agir sur un compte de rang ÉGAL', () => {
    // Deux administrateurs ne doivent pas pouvoir se désactiver mutuellement.
    expect(canActOnUser(RANKS.ADMIN, RANKS.ADMIN)).toBe(false);
  });

  it('autorise à agir sur un rang strictement inférieur', () => {
    expect(canActOnUser(RANKS.ADMIN, RANKS.EDITOR)).toBe(true);
  });

  it('interdit d’agir sur un rang supérieur', () => {
    expect(canActOnUser(RANKS.EDITOR, RANKS.ADMIN)).toBe(false);
  });

  it('interdit d’attribuer son PROPRE rang — c’est déjà une escalade', () => {
    expect(canAssignRank(RANKS.ADMIN, RANKS.ADMIN)).toBe(false);
    expect(canAssignRank(RANKS.ADMIN, RANKS.EDITOR)).toBe(true);
  });
});

describe('unauthorizedPermissions', () => {
  it('exempte le super_admin', () => {
    expect(unauthorizedPermissions(RANKS.SUPER_ADMIN, [], [PERMISSIONS.USERS_DELETE])).toEqual([]);
  });

  it('signale les codes que l’acteur ne détient pas lui-même', () => {
    expect(
      unauthorizedPermissions(
        RANKS.ADMIN,
        [PERMISSIONS.USERS_READ],
        [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_DELETE],
      ),
    ).toEqual([PERMISSIONS.USERS_DELETE]);
  });

  it('ne signale rien quand l’acteur détient tout ce qu’il demande', () => {
    expect(
      unauthorizedPermissions(RANKS.ADMIN, [PERMISSIONS.USERS_READ], [PERMISSIONS.USERS_READ]),
    ).toEqual([]);
  });
});
