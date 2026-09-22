import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  FeedbackCountsSchema,
  FeedbackListResponseSchema,
  FeedbackSchema,
  type CreateFeedbackInput,
  type Feedback,
  type FeedbackCounts,
  type FeedbackListResponse,
  type TriageFeedbackInput,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/** Filtres de lecture, tels que l'interface les manipule — tout est facultatif. */
export interface FeedbackFilters {
  status?: string;
  kind?: string;
  severity?: string;
  search?: string;
  mine?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Client HTTP des retours.
 *
 * Aucune méthode de suppression ni de réécriture : l'API n'en expose pas, et
 * un client qui en offrirait donnerait une fausse idée de ce que l'outil
 * garantit à celui qui dépose un retour.
 *
 * Pas de lecture unitaire non plus : la liste porte déjà le retour complet, et
 * `GET /feedback/:id` n'aurait ici aucun appelant. La route existe côté API et
 * ce client la rajoutera le jour où un écran en aura besoin.
 */
@Injectable({ providedIn: 'root' })
export class FeedbackApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private toParams(filtres: FeedbackFilters): HttpParams {
    let params = new HttpParams();
    for (const [cle, valeur] of Object.entries(filtres)) {
      // Les valeurs vides sont OMISES : le schéma du backend est strict, et un
      // `status=` vide n'exprime aucun filtre.
      if (valeur === undefined || valeur === null || valeur === '') continue;
      params = params.set(cle, String(valeur));
    }
    return params;
  }

  async list(filtres: FeedbackFilters = {}): Promise<FeedbackListResponse> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/feedback`, { params: this.toParams(filtres) }),
    );
    return FeedbackListResponseSchema.parse(brut);
  }

  async counts(): Promise<FeedbackCounts> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/feedback/compteurs`));
    return FeedbackCountsSchema.parse(brut);
  }

  async create(entree: CreateFeedbackInput): Promise<Feedback> {
    const brut = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/feedback`, entree));
    return FeedbackSchema.parse(brut);
  }

  async triage(id: string, entree: TriageFeedbackInput): Promise<Feedback> {
    const brut = await firstValueFrom(
      this.http.patch<unknown>(`${this.baseUrl}/feedback/${id}`, entree),
    );
    return FeedbackSchema.parse(brut);
  }
}
