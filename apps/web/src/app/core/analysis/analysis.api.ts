import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ZodType } from 'zod';
import {
  AnalysisReportSchema,
  BatchResponseSchema,
  SitemapParseResponseSchema,
  SseAnalyzeEventSchema,
  SseBatchEventSchema,
  type AnalysisReport,
  type BatchResponse,
  type SitemapParseResponse,
  type SseAnalyzeEvent,
  type SseBatchEvent,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from '../auth/csrf';

/** Requête d'analyse telle que l'interface la compose. */
export interface AnalyzeInput {
  url: string;
  profileOverride?: string;
}

/**
 * Client du moteur d'analyse.
 *
 * Chaque réponse est validée contre le schéma PARTAGÉ — y compris chaque
 * événement du flux : un événement mal formé serait accepté comme du JSON
 * valide et casserait l'affichage sans rien dire.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  async analyze(input: AnalyzeInput): Promise<AnalysisReport> {
    const raw = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/analyze`, this.bodyOf(input)),
    );
    return AnalysisReportSchema.parse(raw);
  }

  async batch(urls: readonly string[], profileOverride?: string): Promise<BatchResponse> {
    const body = { urls: [...urls], ...(profileOverride ? { profileOverride } : {}) };
    const raw = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/analyze/batch`, body),
    );
    return BatchResponseSchema.parse(raw);
  }

  async detectSitemap(url: string): Promise<string | null> {
    const raw = await firstValueFrom(
      this.http.get<{ sitemapUrl: string | null }>(`${this.baseUrl}/sitemap/detect`, {
        params: { url },
      }),
    );
    return raw.sitemapUrl;
  }

  async parseSitemap(url: string, limit: number): Promise<SitemapParseResponse> {
    const raw = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/sitemap/parse`, { url, limit }),
    );
    return SitemapParseResponseSchema.parse(raw);
  }

  /**
   * Analyse en flux, critère par critère.
   *
   * `fetch` et non `EventSource` : la source d'événements native ne sait faire
   * que du GET, et l'URL analysée n'a rien à faire dans une barre d'adresse ni
   * dans les journaux d'un proxy. Le flux est donc lu à la main sur la réponse
   * d'un POST.
   */
  async *stream(input: AnalyzeInput, signal?: AbortSignal): AsyncGenerator<SseAnalyzeEvent> {
    const response = await fetch(`${this.baseUrl}/analyze/stream`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        // Le double-submit CSRF s'applique : `fetch` ne traverse PAS les
        // intercepteurs Angular, le jeton est donc posé explicitement ici.
        [CSRF_HEADER]: readCookie(CSRF_COOKIE) ?? '',
      },
      body: JSON.stringify(this.bodyOf(input)),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Analyse impossible (${response.status})`);
    }

    yield* readSseStream(response.body, SseAnalyzeEventSchema, signal);
  }

  /**
   * Analyse d'un lot, page par page.
   *
   * Le lot en une seule réponse fige l'écran pendant toute sa durée — plusieurs
   * minutes sur deux cents pages — puis livre des mégaoctets d'un coup. Ici
   * chaque page arrive dès qu'elle est terminée.
   */
  async *batchStream(
    urls: readonly string[],
    profileOverride?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SseBatchEvent> {
    const response = await fetch(`${this.baseUrl}/analyze/batch/stream`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        // Le double-submit CSRF s'applique : `fetch` ne traverse PAS les
        // intercepteurs Angular, le jeton est donc posé explicitement ici.
        [CSRF_HEADER]: readCookie(CSRF_COOKIE) ?? '',
      },
      body: JSON.stringify({
        urls: [...urls],
        ...(profileOverride ? { profileOverride } : {}),
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Analyse du lot impossible (${response.status})`);
    }

    yield* readSseStream(response.body, SseBatchEventSchema, signal);
  }

  private bodyOf(input: AnalyzeInput): Record<string, unknown> {
    return {
      url: input.url,
      ...(input.profileOverride ? { profileOverride: input.profileOverride } : {}),
    };
  }
}

/**
 * Découpe un flux SSE en événements validés.
 *
 * Exporté pour être testé seul : c'est un analyseur syntaxique, et le tester à
 * travers le réseau reviendrait à ne pas le tester du tout. Les événements
 * arrivent par paquets TCP arbitraires — un événement peut être coupé en deux,
 * ou deux événements arriver ensemble —, d'où le tampon.
 */
export async function* readSseStream<TEvent>(
  body: ReadableStream<Uint8Array>,
  schema: ZodType<TEvent>,
  signal?: AbortSignal,
): AsyncGenerator<TEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const chunk = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const event = parseSseChunk(chunk, schema);
        if (event) yield event;

        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Lit un bloc `data:` et le valide.
 *
 * Un bloc illisible est IGNORÉ plutôt que de faire échouer le flux : perdre un
 * événement de progression est sans conséquence, perdre l'analyse entière en a
 * une.
 */
function parseSseChunk<TEvent>(chunk: string, schema: ZodType<TEvent>): TEvent | null {
  const line = chunk.split('\n').find(candidate => candidate.startsWith('data:'));
  if (!line) return null;

  try {
    const parsed: unknown = JSON.parse(line.slice('data:'.length).trim());
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
