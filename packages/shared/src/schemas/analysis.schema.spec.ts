import { describe, expect, it } from 'vitest';
import {
  AnalyzableUrlSchema,
  AnalyzeRequestSchema,
  BatchRequestSchema,
  MAX_BATCH_URLS,
  SitemapParseResponseSchema,
  SitemapRequestSchema,
  SseAnalyzeEventSchema,
  SseBatchEventSchema,
} from './analysis.schema.js';

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

describe('AnalyzableUrlSchema', () => {
  it.each(['https://exemple.fr/', 'http://exemple.fr/page?a=1'])('accepte %s', url => {
    expect(AnalyzableUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ['file:///etc/passwd', 'lecture du disque'],
    ['gopher://exemple.fr/', 'protocole détourné'],
    ['data:text/html,<script>alert(1)</script>', 'charge embarquée'],
    ['javascript:alert(1)', 'exécution côté client'],
    ['ftp://exemple.fr/', 'protocole non maîtrisé'],
  ])('REFUSE %s (%s)', (url, _why) => {
    // Ce sont des URL parfaitement valides au sens de la norme : seul le
    // protocole les distingue, et les refuser ici évite d'engager la moindre
    // résolution DNS.
    expect(AnalyzableUrlSchema.safeParse(url).success).toBe(false);
  });

  it('ignore la CASSE du protocole', () => {
    // `HTTPS://` est la même chose que `https://` : refuser la majuscule ne
    // protégerait de rien et casserait des liens copiés à la main.
    expect(AnalyzableUrlSchema.safeParse('HTTPS://exemple.fr/').success).toBe(true);
  });

  it('refuse une chaîne qui n’est pas une URL', () => {
    expect(AnalyzableUrlSchema.safeParse('exemple.fr').success).toBe(false);
  });

  it('borne la longueur', () => {
    expect(AnalyzableUrlSchema.safeParse(`https://a.fr/${'x'.repeat(2100)}`).success).toBe(false);
  });
});

describe('AnalyzeRequestSchema', () => {
  it('accepte une requête minimale', () => {
    expect(AnalyzeRequestSchema.safeParse({ url: 'https://exemple.fr/' }).success).toBe(true);
  });

  it('accepte une surcharge PARTIELLE de réglages', () => {
    // L'appelant n'envoie que ce qu'il surcharge ; le service fusionne sur le
    // profil résolu et décide de la valeur finale.
    const result = AnalyzeRequestSchema.safeParse({
      url: 'https://exemple.fr/',
      settings: { enabledChecks: ['METAS'] },
    });
    expect(result.success).toBe(true);
  });

  it('REJETTE un champ surnuméraire', () => {
    expect(
      AnalyzeRequestSchema.safeParse({ url: 'https://exemple.fr/', renderMode: 'browser' }).success,
    ).toBe(false);
  });

  it('accepte un profil choisi', () => {
    expect(
      AnalyzeRequestSchema.safeParse({ url: 'https://exemple.fr/', profileOverride: 'premium' })
        .success,
    ).toBe(true);
  });
});

describe('BatchRequestSchema', () => {
  it('accepte un lot d’URL', () => {
    expect(BatchRequestSchema.safeParse({ urls: ['https://a.fr/', 'https://b.fr/'] }).success).toBe(
      true,
    );
  });

  it('refuse un lot vide', () => {
    expect(BatchRequestSchema.safeParse({ urls: [] }).success).toBe(false);
  });

  it('BORNE la taille du lot plutôt que de tronquer en silence', () => {
    const urls = Array.from({ length: MAX_BATCH_URLS + 1 }, (_, i) => `https://a.fr/${i}`);
    expect(BatchRequestSchema.safeParse({ urls }).success).toBe(false);
  });

  it('refuse un lot contenant UNE seule URL non analysable', () => {
    // Un lot n'est pas un moyen de faire passer ce qu'une requête unitaire
    // refuserait.
    expect(
      BatchRequestSchema.safeParse({ urls: ['https://a.fr/', 'file:///etc/passwd'] }).success,
    ).toBe(false);
  });
});

describe('SitemapRequestSchema', () => {
  it('applique les valeurs par défaut', () => {
    const result = SitemapRequestSchema.parse({ url: 'https://exemple.fr/sitemap.xml' });
    expect(result).toMatchObject({ limit: 20, filterByPriority: false });
  });

  it('plafonne la limite', () => {
    expect(SitemapRequestSchema.safeParse({ url: 'https://a.fr/s.xml', limit: 5000 }).success).toBe(
      false,
    );
  });
});

describe('SitemapParseResponseSchema', () => {
  it('distingue le nombre DÉCOUVERT du nombre retourné', () => {
    // Dire à l'utilisateur combien d'URL il ne verra pas évite de lui laisser
    // croire que son sitemap n'en contient que vingt.
    const result = SitemapParseResponseSchema.safeParse({
      sitemapUrl: 'https://exemple.fr/sitemap.xml',
      discovered: 340,
      entries: [{ url: 'https://exemple.fr/', lastmod: null, priority: 0.8 }],
      truncated: true,
    });
    expect(result.success).toBe(true);
  });

  it('refuse une priorité hors bornes', () => {
    const result = SitemapParseResponseSchema.safeParse({
      sitemapUrl: 'https://exemple.fr/sitemap.xml',
      discovered: 1,
      entries: [{ url: 'https://exemple.fr/', lastmod: null, priority: 3 }],
      truncated: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('SseAnalyzeEventSchema', () => {
  it('accepte un événement de départ', () => {
    const result = SseAnalyzeEventSchema.safeParse({
      type: 'start',
      analyzeId: ANALYZE_ID,
      url: 'https://exemple.fr/',
      total: 29,
    });
    expect(result.success).toBe(true);
  });

  it('accepte un événement d’erreur sans identifiant', () => {
    // L'échec peut survenir AVANT qu'une analyse ait été ouverte.
    const result = SseAnalyzeEventSchema.safeParse({
      type: 'error',
      analyzeId: null,
      message: 'URL injoignable',
    });
    expect(result.success).toBe(true);
  });

  it('refuse un type d’événement inconnu', () => {
    expect(SseAnalyzeEventSchema.safeParse({ type: 'heartbeat' }).success).toBe(false);
  });

  it('BORNE le message d’erreur', () => {
    // Un flux SSE contourne le filtre d'exceptions global — les en-têtes sont
    // déjà partis — donc l'assainissement doit tenir ici.
    const result = SseAnalyzeEventSchema.safeParse({
      type: 'error',
      analyzeId: null,
      message: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe('SseBatchEventSchema', () => {
  it('accepte une page échouée sans rapport', () => {
    // L'échec d'une page ne fait pas échouer le lot : chaque entrée porte son
    // propre sort.
    const result = SseBatchEventSchema.safeParse({
      type: 'page',
      batchId: ANALYZE_ID,
      completed: 3,
      total: 10,
      url: 'https://exemple.fr/perdue',
      ok: false,
      report: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepte le récapitulatif final', () => {
    const result = SseBatchEventSchema.safeParse({
      type: 'complete',
      batchId: ANALYZE_ID,
      total: 10,
      succeeded: 9,
      failed: 1,
      durationMs: 42_000,
    });
    expect(result.success).toBe(true);
  });

  it('refuse un décompte négatif', () => {
    const result = SseBatchEventSchema.safeParse({
      type: 'start',
      batchId: ANALYZE_ID,
      total: -1,
    });
    expect(result.success).toBe(false);
  });
});
