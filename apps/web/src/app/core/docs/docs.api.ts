import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  DocIndexSchema,
  DocPageSchema,
  DocSearchResponseSchema,
  type DocIndex,
  type DocPage,
  type DocSearchResponse,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Client HTTP du portail de documentation.
 *
 * Trois lectures, aucune écriture : les pages vivent dans le dépôt et se
 * modifient par une revue de code. Un client qui offrirait une écriture
 * laisserait croire à une commande qui n'existe pas.
 *
 * Chaque réponse repasse par le schéma partagé avant d'atteindre l'écran. Ce
 * n'est pas une défiance envers notre propre API : c'est la garantie que le
 * rendu ne voit JAMAIS qu'un bloc du type attendu. Une réponse hors-schéma
 * lève ici, au lieu de traverser les gabarits avec une forme imprévue.
 */
@Injectable({ providedIn: 'root' })
export class DocsApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async index(): Promise<DocIndex> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/docs`));
    return DocIndexSchema.parse(brut);
  }

  async page(slug: string): Promise<DocPage> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/docs/${encodeURIComponent(slug)}`),
    );
    return DocPageSchema.parse(brut);
  }

  async rechercher(q: string, limit?: number): Promise<DocSearchResponse> {
    let params = new HttpParams().set('q', q);
    if (limit !== undefined) params = params.set('limit', String(limit));
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/docs/recherche`, { params }),
    );
    return DocSearchResponseSchema.parse(brut);
  }
}
