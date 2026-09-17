import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { RANKS, type PermissionCode } from '@websentry/shared';
import { AuthService } from '../auth/auth.service';

/**
 * Gardes de route.
 *
 * Elles servent l'EXPÉRIENCE, pas la sécurité : elles évitent d'afficher un écran
 * que l'API refuserait de nourrir. La protection réelle des données est posée par
 * les gardes du backend, que ces fonctions ne font que refléter. Contourner une
 * garde ici ne donne accès à aucune donnée.
 */

/** Résout le profil si ce n'est pas encore fait — le cookie est invisible d'ici. */
async function ensureResolved(auth: AuthService): Promise<void> {
  if (auth.user() === null && auth.loading()) {
    await auth.refreshProfile();
  }
}

/** Exige une session ouverte. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await ensureResolved(auth);
  if (auth.isAuthenticated()) return true;

  // `retour` permet de ramener l'utilisateur là où il allait après connexion.
  return router.createUrlTree(['/connexion'], { queryParams: { retour: state.url } });
};

/** Exige un rang minimal. */
export function rankGuard(minRank: number): CanActivateFn {
  return async () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    await ensureResolved(auth);
    if (!auth.isAuthenticated()) return router.createUrlTree(['/connexion']);
    if (auth.rank() >= minRank) return true;

    return router.createUrlTree(['/acces-refuse']);
  };
}

/** Exige une permission fine. */
export function permissionGuard(code: PermissionCode): CanActivateFn {
  return async () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    await ensureResolved(auth);
    if (!auth.isAuthenticated()) return router.createUrlTree(['/connexion']);
    if (auth.hasPermission(code)) return true;

    return router.createUrlTree(['/acces-refuse']);
  };
}

/** Raccourcis lisibles, en miroir des décorateurs du backend. */
export const adminGuard = rankGuard(RANKS.ADMIN);
export const superAdminGuard = rankGuard(RANKS.SUPER_ADMIN);
export const editorGuard = rankGuard(RANKS.EDITOR);

/**
 * Empêche un utilisateur déjà connecté de revenir sur l'écran de connexion.
 */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await ensureResolved(auth);
  return auth.isAuthenticated() ? router.createUrlTree(['/tableau-de-bord']) : true;
};
