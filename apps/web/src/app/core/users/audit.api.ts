import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuditListResponseSchema, type AuditListResponse } from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/** Filtres du journal, tels que l'interface les manipule — tout est facultatif. */
export interface AuditFilters {
  actor?: string;
  action?: string;
  targetId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * Client HTTP du journal d'audit.
 *
 * Lecture seule, et c'est tout ce que l'API propose : le journal est
 * append-only, ni purge ni correction n'existent côté serveur.
 */
@Injectable({ providedIn: 'root' })
export class AuditApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async list(filtres: AuditFilters = {}): Promise<AuditListResponse> {
    let params = new HttpParams();
    for (const [cle, valeur] of Object.entries(filtres)) {
      // Les valeurs vides sont OMISES : le schéma du backend est strict, et un
      // `actor=` vide n'exprime aucun filtre.
      if (valeur === undefined || valeur === null || valeur === '') continue;
      params = params.set(cle, String(valeur));
    }

    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/audit`, { params }));
    return AuditListResponseSchema.parse(brut);
  }
}
