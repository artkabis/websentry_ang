import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SupervisionSchema, type Supervision } from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Client HTTP de la supervision — lecture seule.
 *
 * L'API n'expose aucune commande d'exploitation, et ce client n'en invente
 * pas : redémarrer un pool ou forcer une purge depuis une page web serait une
 * surface d'attaque pour un gain nul.
 */
@Injectable({ providedIn: 'root' })
export class SupervisionApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async releve(): Promise<Supervision> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/supervision`));
    return SupervisionSchema.parse(brut);
  }
}
