import type { CurrentUser, GrantedPermission, Role } from '@websentry/shared';

export type { CurrentUser, GrantedPermission, Role };

/** État d'authentification observable par l'interface. */
export interface AuthState {
  /** `null` tant que le profil n'a pas été résolu, ou après déconnexion. */
  user: CurrentUser | null;
  /** `true` pendant la résolution initiale — évite un écran de connexion clignotant. */
  loading: boolean;
  error: string | null;
}
