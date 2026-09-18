import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  ScanPageListSchema,
  ScanStatsSchema,
  SessionComparisonSchema,
  SessionReportSchema,
  SiteListSchema,
  SiteSessionListSchema,
  type ScanPageList,
  type ScanSearchQuery,
  type ScanStats,
  type SessionComparison,
  type SessionReport,
  type SiteList,
  type SiteSession,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/**
 * Le scan existe, mais la rétention a effacé son rapport.
 *
 * Erreur TYPÉE et non un 410 brut : l'interface doit pouvoir dire « purgé le
 * … , le résumé reste consultable » plutôt que d'afficher un échec générique
 * qui laisserait croire à une panne.
 */
export class ScanReportPurgedError extends Error {
  constructor(readonly purgedAt: string | null) {
    super(
      purgedAt
        ? `Le rapport complet a été purgé le ${purgedAt.slice(0, 10)}. ` +
            'Le résumé des critères reste consultable.'
        : 'Le rapport complet a été purgé. Le résumé des critères reste consultable.',
    );
    this.name = 'ScanReportPurgedError';
  }
}

/** Filtres de recherche tels que l'interface les manipule — tout est facultatif. */
export type ScanFilters = Partial<ScanSearchQuery>;

/**
 * Client HTTP de l'historique des scans.
 *
 * Chaque réponse est validée contre le schéma PARTAGÉ : une API qui dérive est
 * détectée à la frontière, pas trois écrans plus loin sous la forme d'un champ
 * manquant.
 */
@Injectable({ providedIn: 'root' })
export class ScansApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /**
   * Construit la chaîne de requête.
   *
   * Les valeurs vides sont OMISES plutôt qu'envoyées vides : le schéma du
   * backend refuse les paramètres qu'il ne connaît pas, et un `gamme=` vide
   * n'exprime aucun filtre — l'envoyer transformerait « pas de filtre » en
   * « filtre sur la chaîne vide ».
   */
  private toParams(filters: ScanFilters): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      params = params.set(key, String(value));
    }
    return params;
  }

  async searchPages(filters: ScanFilters = {}): Promise<ScanPageList> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/scans`, { params: this.toParams(filters) }),
    );
    return ScanPageListSchema.parse(raw);
  }

  async listSites(filters: ScanFilters = {}): Promise<SiteList> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/scans/sites`, { params: this.toParams(filters) }),
    );
    return SiteListSchema.parse(raw);
  }

  async siteSessions(domain: string, gamme: string | null): Promise<SiteSession[]> {
    const params = this.toParams({ domain, ...(gamme ? { gamme } : {}) });
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/scans/sites/sessions`, { params }),
    );
    return SiteSessionListSchema.parse(raw);
  }

  async session(sessionId: string): Promise<SessionReport> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/scans/sessions/${encodeURIComponent(sessionId)}`),
    );
    return SessionReportSchema.parse(raw);
  }

  async compare(baseId: string, targetId: string): Promise<SessionComparison> {
    const raw = await firstValueFrom(
      this.http.get<unknown>(
        `${this.baseUrl}/scans/sessions/${encodeURIComponent(baseId)}` +
          `/compare/${encodeURIComponent(targetId)}`,
      ),
    );
    return SessionComparisonSchema.parse(raw);
  }

  async stats(): Promise<ScanStats> {
    const raw = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/scans/stats`));
    return ScanStatsSchema.parse(raw);
  }

  async pageReport(pageId: string): Promise<unknown> {
    try {
      const raw = await firstValueFrom(
        this.http.get<{ report: unknown }>(`${this.baseUrl}/scans/${encodeURIComponent(pageId)}`),
      );
      return raw.report;
    } catch (err) {
      throw this.asPurged(err);
    }
  }

  async deletePages(ids: readonly string[]): Promise<number> {
    const res = await firstValueFrom(
      this.http.delete<{ deleted: number }>(`${this.baseUrl}/scans`, { body: { ids: [...ids] } }),
    );
    return res.deleted;
  }

  async deleteSession(sessionId: string): Promise<number> {
    const res = await firstValueFrom(
      this.http.delete<{ deleted: number }>(
        `${this.baseUrl}/scans/sessions/${encodeURIComponent(sessionId)}`,
      ),
    );
    return res.deleted;
  }

  async deleteSite(domain: string, gamme: string | null): Promise<number> {
    const res = await firstValueFrom(
      this.http.delete<{ deleted: number }>(`${this.baseUrl}/scans/sites`, {
        // `gamme` est TOUJOURS transmise, fût-elle nulle : l'omettre ferait
        // refuser la requête, et la traiter comme « toutes gammes » effacerait
        // bien plus que ce que l'utilisateur a demandé.
        body: { domain, gamme },
      }),
    );
    return res.deleted;
  }

  /**
   * Transforme un 410 en erreur typée.
   *
   * Toute autre erreur est relayée telle quelle : la traduire masquerait sa
   * nature (403, 404, 503…) au composant qui doit la présenter.
   */
  private asPurged(err: unknown): unknown {
    if (!(err instanceof HttpErrorResponse) || err.status !== 410) return err;

    const details = (err.error as { details?: { purgedAt?: unknown } })?.details;
    const purgedAt = typeof details?.purgedAt === 'string' ? details.purgedAt : null;
    return new ScanReportPurgedError(purgedAt);
  }
}
