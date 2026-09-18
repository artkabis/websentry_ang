import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  ProfileExportSchema,
  ProfileListSchema,
  RegistryResponseSchema,
  SettingsProfileSchema,
  type AnalysisSettings,
  type ProfileExport,
  type ProfileMeta,
  type RegistryResponse,
  type SettingsProfile,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Conflit de verrouillage optimiste remonté par l'API.
 *
 * Porte les deux versions pour que l'interface puisse proposer un rechargement
 * sans requête supplémentaire — c'est précisément le rôle du canal `details`
 * ouvert côté backend.
 */
export class ProfileConflictError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly expectedVersion: number,
  ) {
    super(
      `Ce profil a été modifié entre-temps (version ${currentVersion}). ` +
        'Rechargez-le avant d’enregistrer vos modifications.',
    );
    this.name = 'ProfileConflictError';
  }
}

/** Corps d'écriture d'un profil. */
export interface SaveProfilePayload {
  settings: AnalysisSettings;
  label?: string;
  description?: string | null;
  expectedVersion?: number;
}

/**
 * Client HTTP des profils et du registre.
 *
 * Chaque réponse est validée contre le schéma PARTAGÉ : une API qui dérive est
 * détectée ici, à la frontière, et non trois écrans plus loin sous la forme
 * d'un champ manquant.
 */
@Injectable({ providedIn: 'root' })
export class ProfilesApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async list(): Promise<ProfileMeta[]> {
    const raw = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/profiles`));
    return ProfileListSchema.parse(raw);
  }

  async get(gamme: string): Promise<SettingsProfile> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}`),
    );
    return SettingsProfileSchema.parse(raw);
  }

  async save(gamme: string, payload: SaveProfilePayload): Promise<SettingsProfile> {
    try {
      const raw = await firstValueFrom(
        this.http.put<unknown>(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}`, payload),
      );
      return SettingsProfileSchema.parse(raw);
    } catch (err) {
      throw this.asConflict(err);
    }
  }

  async remove(gamme: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}`));
  }

  async reset(gamme: string): Promise<SettingsProfile> {
    const raw = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}/reset`, {}),
    );
    return SettingsProfileSchema.parse(raw);
  }

  async exportProfile(gamme: string): Promise<ProfileExport> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}/export`),
    );
    return ProfileExportSchema.parse(raw);
  }

  async importProfile(
    gamme: string,
    payload: ProfileExport,
    expectedVersion?: number,
  ): Promise<SettingsProfile> {
    try {
      const raw = await firstValueFrom(
        this.http.post<unknown>(`${this.baseUrl}/profiles/${encodeURIComponent(gamme)}/import`, {
          payload,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        }),
      );
      return SettingsProfileSchema.parse(raw);
    } catch (err) {
      throw this.asConflict(err);
    }
  }

  async registry(): Promise<RegistryResponse> {
    const raw = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/registry`));
    return RegistryResponseSchema.parse(raw);
  }

  /** Réglages globaux — le backend les sert depuis le profil `default`. */
  async settings(): Promise<SettingsProfile> {
    const raw = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/settings`));
    return SettingsProfileSchema.parse(raw);
  }

  /**
   * Transforme un 409 en erreur typée, exploitable par l'interface.
   *
   * Toute autre erreur est relayée telle quelle : la traduire ici masquerait
   * sa nature (403, 503…) au composant qui doit la présenter.
   */
  private asConflict(err: unknown): unknown {
    if (!(err instanceof HttpErrorResponse) || err.status !== 409) return err;

    const details = (
      err.error as { details?: { currentVersion?: unknown; expectedVersion?: unknown } }
    )?.details;
    if (
      typeof details?.currentVersion !== 'number' ||
      typeof details.expectedVersion !== 'number'
    ) {
      return err;
    }
    return new ProfileConflictError(details.currentVersion, details.expectedVersion);
  }
}
