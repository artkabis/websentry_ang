import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  UserListResponseSchema,
  UserPermissionSchema,
  UserSummarySchema,
  type CreateUserInput,
  type GrantPermissionInput,
  type UpdateUserInput,
  type UserListResponse,
  type UserPermission,
  type UserSummary,
} from '@websentry/shared';
import * as z from 'zod';
import { API_BASE_URL } from '../api/api.config';

/** Filtres de la liste, tels que l'interface les manipule — tout est facultatif. */
export interface UserFilters {
  search?: string;
  rank?: number | null;
  status?: string;
  limit?: number;
  offset?: number;
}

const UserPermissionListSchema = z.array(UserPermissionSchema);

/**
 * Client HTTP de l'administration des comptes.
 *
 * Chaque réponse est validée contre le schéma PARTAGÉ. Ici la vérification vaut
 * plus qu'ailleurs : ces réponses décrivent des DROITS, et un champ manquant
 * silencieusement — un rang, un statut — ferait afficher un compte pour ce
 * qu'il n'est pas.
 */
@Injectable({ providedIn: 'root' })
export class UsersApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /**
   * Les valeurs vides sont OMISES plutôt qu'envoyées vides : le schéma du
   * backend est strict, et un `status=` vide n'exprime aucun filtre — l'envoyer
   * transformerait « pas de filtre » en « filtre sur la chaîne vide ».
   */
  private toParams(filters: UserFilters): HttpParams {
    let params = new HttpParams();
    for (const [cle, valeur] of Object.entries(filters)) {
      if (valeur === undefined || valeur === null || valeur === '') continue;
      params = params.set(cle, String(valeur));
    }
    return params;
  }

  async list(filters: UserFilters = {}): Promise<UserListResponse> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/users`, { params: this.toParams(filters) }),
    );
    return UserListResponseSchema.parse(brut);
  }

  async get(id: string): Promise<UserSummary> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/users/${id}`));
    return UserSummarySchema.parse(brut);
  }

  async create(entree: CreateUserInput): Promise<UserSummary> {
    const brut = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/users`, entree));
    return UserSummarySchema.parse(brut);
  }

  async update(id: string, entree: UpdateUserInput): Promise<UserSummary> {
    const brut = await firstValueFrom(
      this.http.patch<unknown>(`${this.baseUrl}/users/${id}`, entree),
    );
    return UserSummarySchema.parse(brut);
  }

  /** Route DISTINCTE de la mise à jour — cf. `docs/DECISIONS.md` §40. */
  async resetPassword(id: string, password: string): Promise<void> {
    await firstValueFrom(
      this.http.post<void>(`${this.baseUrl}/users/${id}/password`, { password }),
    );
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/users/${id}`));
  }

  async listPermissions(id: string): Promise<UserPermission[]> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/users/${id}/permissions`),
    );
    return UserPermissionListSchema.parse(brut);
  }

  async grantPermission(id: string, octroi: GrantPermissionInput): Promise<void> {
    await firstValueFrom(this.http.put<void>(`${this.baseUrl}/users/${id}/permissions`, octroi));
  }

  async revokePermission(id: string, permission: string): Promise<void> {
    // Le code de permission contient un deux-points (`users:read`) : sans
    // encodage, il se retrouverait interprété dans le chemin.
    await firstValueFrom(
      this.http.delete<void>(
        `${this.baseUrl}/users/${id}/permissions/${encodeURIComponent(permission)}`,
      ),
    );
  }
}
