/**
 * Hiérarchie de rôles WebSentry — portée telle quelle depuis la v1.
 *
 * Le RANG est la source de vérité (entier stocké en base, contrainte
 * `CHECK (rank IN (10, 30, 50, 100))`). Le « rôle » n'est qu'une étiquette
 * dérivée, destinée à l'affichage et aux gardes de route côté Angular.
 */

/** Rangs numériques — ordre total, un rang supérieur domine tous les inférieurs. */
export const RANKS = {
  TESTER: 10,
  EDITOR: 30,
  ADMIN: 50,
  SUPER_ADMIN: 100,
} as const;

export type Rank = (typeof RANKS)[keyof typeof RANKS];

/** Rangs valides, tels que contraints par `CHECK (rank IN (...))` côté MariaDB. */
export const VALID_RANKS: readonly number[] = Object.values(RANKS);

export type Role = 'tester' | 'editor' | 'admin' | 'super_admin';

/** Convertit un rang numérique en étiquette de rôle (seuils décroissants). */
export function rankToRole(rank: number): Role {
  if (rank >= RANKS.SUPER_ADMIN) return 'super_admin';
  if (rank >= RANKS.ADMIN) return 'admin';
  if (rank >= RANKS.EDITOR) return 'editor';
  return 'tester';
}

/** Rang minimal associé à une étiquette de rôle. */
export function roleToRank(role: Role): Rank {
  switch (role) {
    case 'super_admin':
      return RANKS.SUPER_ADMIN;
    case 'admin':
      return RANKS.ADMIN;
    case 'editor':
      return RANKS.EDITOR;
    case 'tester':
      return RANKS.TESTER;
  }
}

// ── Codes de permission ──────────────────────────────────────────────────────

/**
 * Catalogue des permissions fines (parité v1 — cf. `rbac.service.ts`).
 *
 * `AUDIT_READ` reste RÉSERVÉ au super_admin : la route du journal d'audit est
 * gardée par le rang 100, pas par ce code. Il n'est donc jamais accordable à un
 * rang inférieur — le conserver ici documente le code réservé.
 */
export const PERMISSIONS = {
  SCAN_RUN: 'scan:run',
  SCAN_BATCH: 'scan:batch',
  HISTORY_READ: 'history:read',
  HISTORY_DELETE: 'history:delete',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  PROFILES_WRITE: 'profiles:write',
  PROFILES_USE: 'profiles:use',
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  USERS_DELETE: 'users:delete',
  AUDIT_READ: 'audit:read',
  DOCS_READ: 'docs:read',
  USAGE_READ: 'usage:read',
  HEALTH_READ: 'health:read',
  FEEDBACK_READ: 'feedback:read',
  MESSAGES_WRITE: 'messages:write',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly PermissionCode[] = Object.values(PERMISSIONS);

/**
 * Permissions par défaut de chaque rang — seedées à la création d'un compte.
 *
 * Ces listes expriment l'INTENTION d'un rang. L'accès effectif dépend de la garde
 * posée sur la route : un code n'a d'effet que si une route le consulte réellement.
 */
export const RANK_DEFAULT_PERMISSIONS: Readonly<Record<number, readonly PermissionCode[]>> = {
  [RANKS.SUPER_ADMIN]: ALL_PERMISSIONS,
  [RANKS.ADMIN]: [
    PERMISSIONS.SCAN_RUN,
    PERMISSIONS.SCAN_BATCH,
    PERMISSIONS.HISTORY_READ,
    PERMISSIONS.HISTORY_DELETE,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.SETTINGS_WRITE,
    PERMISSIONS.PROFILES_WRITE,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_WRITE,
    // PAS `AUDIT_READ` — journal d'audit réservé au rang 100.
    PERMISSIONS.DOCS_READ,
    PERMISSIONS.USAGE_READ,
    PERMISSIONS.HEALTH_READ,
    PERMISSIONS.FEEDBACK_READ,
    PERMISSIONS.MESSAGES_WRITE,
  ],
  [RANKS.EDITOR]: [
    PERMISSIONS.SCAN_RUN,
    PERMISSIONS.SCAN_BATCH,
    PERMISSIONS.HISTORY_READ,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.PROFILES_WRITE,
  ],
  // Tester : PAS `history:read` — il consulte SES scans via `/scans/mine`.
  [RANKS.TESTER]: [PERMISSIONS.SCAN_RUN],
};

/** Vrai si le rang donné détient `code` par défaut (mode sans gestion DB des permissions). */
export function rankHasPermission(rank: number, code: string): boolean {
  for (const [threshold, perms] of Object.entries(RANK_DEFAULT_PERMISSIONS)) {
    if (rank >= Number(threshold) && (perms as readonly string[]).includes(code)) return true;
  }
  return false;
}

/** Permissions par défaut du rang — le palier atteint le plus élevé l'emporte. */
export function defaultPermissionsForRank(rank: number): readonly PermissionCode[] {
  let perms: readonly PermissionCode[] = [];
  for (const [threshold, p] of Object.entries(RANK_DEFAULT_PERMISSIONS)) {
    if (rank >= Number(threshold)) perms = p;
  }
  return perms;
}

// ── Gardes anti-escalade ─────────────────────────────────────────────────────

/** Un acteur ne peut agir que sur un compte STRICTEMENT inférieur au sien. */
export function canActOnUser(actorRank: number, targetRank: number): boolean {
  return actorRank > targetRank;
}

/** Un acteur ne peut attribuer qu'un rang STRICTEMENT inférieur au sien. */
export function canAssignRank(actorRank: number, requestedRank: number): boolean {
  return actorRank > requestedRank;
}

/** Codes qu'un acteur demande sans les détenir lui-même (le super_admin est exempté). */
export function unauthorizedPermissions(
  actorRank: number,
  actorPermissions: readonly string[],
  requestedCodes: readonly string[],
): string[] {
  if (actorRank >= RANKS.SUPER_ADMIN) return [];
  return requestedCodes.filter(code => !actorPermissions.includes(code));
}
