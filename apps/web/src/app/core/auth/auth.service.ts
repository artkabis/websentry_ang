import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  rankHasPermission,
  rankToRole,
  RANKS,
  type AuthSession,
  type CurrentUser,
  type PermissionCode,
  type Role,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Les schémas d'authentification sont chargés À LA DEMANDE, par sous-chemin.
 *
 * `refreshProfile()` est appelée par l'initialiseur d'application : elle est
 * donc, littéralement, la première ligne de code métier exécutée. Un import
 * statique y placerait Zod avant le premier pixel. Ici, le morceau se
 * télécharge pendant que `/auth/me` voyage, et la validation reste entière.
 */
const schemas = () => import('@websentry/shared/schemas/auth');

/**
 * État d'authentification de l'application.
 *
 * Les jetons ne transitent JAMAIS par ce service : ils vivent dans des cookies
 * httpOnly que le JavaScript ne peut pas lire. Ce que l'on garde ici, c'est le
 * profil renvoyé par `/auth/me` — de la donnée d'affichage et de routage, dont
 * l'autorité réelle reste côté serveur.
 *
 * Aucune décision de sécurité ne repose sur cet état : les gardes de route
 * améliorent l'expérience, elles ne protègent pas les données. Chaque appel API
 * est de toute façon revalidé par les gardes du backend.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly _user = signal<CurrentUser | null>(null);
  private readonly _loading = signal(true);
  private readonly _error = signal<string | null>(null);

  /** Profil courant, ou `null` si la session n'est pas (ou plus) établie. */
  readonly user = this._user.asReadonly();
  /** `true` tant que la résolution initiale n'a pas abouti. */
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly rank = computed(() => this._user()?.rank ?? 0);
  readonly role = computed<Role | null>(() => {
    const user = this._user();
    return user ? rankToRole(user.rank) : null;
  });

  readonly isAdmin = computed(() => this.rank() >= RANKS.ADMIN);
  readonly isSuperAdmin = computed(() => this.rank() >= RANKS.SUPER_ADMIN);

  /**
   * Détient la permission `code` ?
   *
   * Le super_admin l'emporte toujours, et un admin bénéficie des défauts de son
   * rang : c'est la même règle que côté serveur (`RbacService.resolve`), afin que
   * l'interface n'affiche jamais une action que l'API refuserait — ni l'inverse.
   */
  hasPermission(code: PermissionCode): boolean {
    const user = this._user();
    if (!user) return false;
    if (user.rank >= RANKS.SUPER_ADMIN) return true;
    if (user.permissions.some(p => p.permission === code)) return true;

    // Repli sur les défauts du RANG, comme `RbacService.resolve`. Sans lui,
    // l'interface refusait à un administrateur sans ligne explicite en base un
    // écran que l'API lui aurait servi : `/auth/me` ne liste que les octrois
    // explicites, jamais ce que le rang donne déjà.
    return rankHasPermission(user.rank, code);
  }

  /** La gamme demandée entre-t-elle dans le scope accordé pour `code` ? */
  gammeInScope(code: PermissionCode, gamme: string | null): boolean {
    if (!gamme) return true;
    const user = this._user();
    if (!user) return false;
    if (user.rank >= RANKS.SUPER_ADMIN) return true;

    const granted = user.permissions.find(p => p.permission === code);
    // Une permission tenue du rang n'a pas de portée : elle vaut partout, comme
    // le `{ gammes: null }` que rend le serveur dans ce même cas.
    if (!granted) return rankHasPermission(user.rank, code);
    if (granted.gammes === null) return true;
    return granted.gammes.some(g => g.toLowerCase() === gamme.toLowerCase());
  }

  /** Ouvre une session. Les cookies sont posés par le serveur. */
  async login(username: string, password: string): Promise<AuthSession> {
    this._error.set(null);
    try {
      const raw = await firstValueFrom(
        this.http.post<unknown>(`${this.baseUrl}/auth/login`, { username, password }),
      );
      // La réponse est validée contre le schéma PARTAGÉ : une API qui dérive est
      // détectée ici, pas trois écrans plus loin.
      const session = (await schemas()).AuthSessionSchema.parse(raw);
      await this.refreshProfile();
      return session;
    } catch (err) {
      this._error.set(this.messageFrom(err));
      throw err;
    }
  }

  /** Ferme la session côté serveur, puis vide l'état local. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${this.baseUrl}/auth/logout`, {}));
    } finally {
      // Vidé même si l'appel échoue : laisser l'interface croire à une session
      // encore ouverte serait plus trompeur qu'utile.
      this._user.set(null);
      this._error.set(null);
    }
  }

  /**
   * Recharge le profil depuis `/auth/me`.
   *
   * Appelée au démarrage : c'est elle qui détermine si une session posée lors
   * d'une visite précédente est encore valide — le front ne peut pas le savoir
   * autrement, puisqu'il ne voit pas le cookie httpOnly.
   */
  async refreshProfile(): Promise<CurrentUser | null> {
    this._loading.set(true);
    try {
      const raw = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/auth/me`));
      const user = (await schemas()).CurrentUserSchema.parse(raw);
      this._user.set(user);
      return user;
    } catch {
      // 401 attendu quand aucune session n'existe : ce n'est pas une erreur à
      // afficher, simplement l'absence de session.
      this._user.set(null);
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  /** Demande une rotation du refresh token. */
  async refreshSession(): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(`${this.baseUrl}/auth/refresh`, {}));
      return true;
    } catch {
      this._user.set(null);
      return false;
    }
  }

  /** Extrait un message affichable, sans jamais exposer de détail technique. */
  private messageFrom(err: unknown): string {
    const candidate = (err as { error?: { message?: unknown } })?.error?.message;
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : 'Connexion impossible — réessayez';
  }
}
