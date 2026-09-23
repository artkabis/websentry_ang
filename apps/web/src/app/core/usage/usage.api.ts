import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  UsageGovernanceSchema,
  UsageOverviewSchema,
  type UsageGovernance,
  type UsageOverview,
  type UsagePeriod,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Client HTTP des analytics d'usage.
 *
 * Deux lectures, et rien d'autre : l'API n'expose aucune écriture, pas même un
 * déclenchement de l'anonymisation. Un client qui en offrirait laisserait
 * croire à une commande qui n'existe pas.
 */
@Injectable({ providedIn: 'root' })
export class UsageApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async overview(periode: UsagePeriod): Promise<UsageOverview> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/usage`, {
        params: new HttpParams().set('periode', periode),
      }),
    );
    return UsageOverviewSchema.parse(brut);
  }

  async governance(): Promise<UsageGovernance> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/usage/gouvernance`));
    return UsageGovernanceSchema.parse(brut);
  }
}
