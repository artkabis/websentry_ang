import { z } from 'zod';
import { AnalysisSettingsObjectSchema } from './settings.schema.js';
import { AnalysisReportSchema, CheckResultSchema } from './report.schema.js';

/**
 * Contrat du moteur d'analyse — requêtes, réponses et flux de progression.
 *
 * Une analyse est la seule opération de l'outil qui **émette des requêtes vers
 * l'extérieur**. Tout ce qui est accepté ici finit, d'une manière ou d'une
 * autre, en connexion sortante : le schéma est donc la première barrière SSRF,
 * avant même la résolution DNS.
 */

/**
 * URL analysable.
 *
 * `http` et `https` UNIQUEMENT. Sans cette restriction, `file:///etc/passwd`,
 * `gopher://` ou `data:` seraient des URL parfaitement valides au sens de la
 * norme — et autant de façons de faire lire au serveur ce qu'il ne devrait pas.
 * Le service SSRF revérifie le protocole, mais le refuser ici évite d'engager
 * la moindre résolution.
 */
export const AnalyzableUrlSchema = z
  .url({
    protocol: /^https?$/,
    error: 'Seuls les protocoles http et https sont analysables',
  })
  .max(2048);

/** Au-delà, un lot est refusé plutôt que tronqué en silence. */
export const MAX_BATCH_URLS = 200;

/**
 * Réglages transmis avec une requête d'analyse.
 *
 * `partial()` : l'appelant n'envoie que ce qu'il surcharge. Le service fusionne
 * sur le profil résolu, et c'est lui — jamais le client — qui décide de la
 * valeur finale.
 */
export const SettingsOverrideSchema = AnalysisSettingsObjectSchema.partial();
export type SettingsOverride = z.infer<typeof SettingsOverrideSchema>;

export const AnalyzeRequestSchema = z
  .object({
    url: AnalyzableUrlSchema,
    settings: SettingsOverrideSchema.optional(),
    /**
     * Profil CHOISI par l'utilisateur. Honoré seulement s'il détient
     * `profiles:use` ; sinon ignoré au profit du profil détecté depuis la page.
     * Ce n'est JAMAIS un motif de refus : un utilisateur sans la permission
     * obtient son analyse, avec le profil auquel il a droit.
     */
    profileOverride: z.string().max(100).optional(),
  })
  .strict();

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

export const BatchRequestSchema = z
  .object({
    urls: z.array(AnalyzableUrlSchema).min(1).max(MAX_BATCH_URLS),
    settings: SettingsOverrideSchema.optional(),
    profileOverride: z.string().max(100).optional(),
  })
  .strict();

export type BatchRequest = z.infer<typeof BatchRequestSchema>;

export const SitemapRequestSchema = z
  .object({
    url: AnalyzableUrlSchema,
    limit: z.number().int().min(1).max(MAX_BATCH_URLS).default(20),
    /** Ne retenir que les URL portant une `<priority>` explicite. */
    filterByPriority: z.boolean().default(false),
  })
  .strict();

export type SitemapRequest = z.infer<typeof SitemapRequestSchema>;

export const SitemapEntrySchema = z
  .object({
    url: z.string().max(2048),
    lastmod: z.string().max(50).nullable(),
    priority: z.number().min(0).max(1).nullable(),
  })
  .strict();

export type SitemapEntry = z.infer<typeof SitemapEntrySchema>;

export const SitemapParseResponseSchema = z
  .object({
    sitemapUrl: z.string().max(2048),
    /** Total DÉCOUVERT, avant application de `limit` — dit à l'utilisateur ce qu'il ne verra pas. */
    discovered: z.number().int().min(0),
    entries: z.array(SitemapEntrySchema).max(MAX_BATCH_URLS),
    truncated: z.boolean(),
  })
  .strict();

export type SitemapParseResponse = z.infer<typeof SitemapParseResponseSchema>;

// ── Réponses ─────────────────────────────────────────────────────────────────

/**
 * Résultat d'une page dans un lot.
 *
 * L'échec d'une page ne fait PAS échouer le lot : analyser cinquante pages et
 * tout perdre parce que la douzième renvoie un 500 serait absurde. Chaque
 * entrée porte donc son propre sort.
 */
export const BatchItemSchema = z
  .object({
    url: z.string().max(2048),
    ok: z.boolean(),
    report: AnalysisReportSchema.nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

export type BatchItem = z.infer<typeof BatchItemSchema>;

export const BatchResponseSchema = z
  .object({
    batchId: z.uuid(),
    total: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    failed: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    results: z.array(BatchItemSchema),
  })
  .strict();

export type BatchResponse = z.infer<typeof BatchResponseSchema>;

// ── Flux de progression (SSE) ────────────────────────────────────────────────

/**
 * Événements d'une analyse de PAGE, critère par critère.
 *
 * La progression est mesurée sur les critères réellement terminés, et non sur
 * une minuterie estimée : une barre qui avance sans rien mesurer ment à
 * l'utilisateur dès que le site analysé est lent.
 */
export const SseStartEventSchema = z
  .object({
    type: z.literal('start'),
    analyzeId: z.uuid(),
    url: z.string().max(2048),
    total: z.number().int().min(0),
  })
  .strict();

export const SseCheckEventSchema = z
  .object({
    type: z.literal('check'),
    analyzeId: z.uuid(),
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
    result: CheckResultSchema,
  })
  .strict();

export const SseCompleteEventSchema = z
  .object({
    type: z.literal('complete'),
    analyzeId: z.uuid(),
    report: AnalysisReportSchema,
  })
  .strict();

/**
 * Événement d'erreur.
 *
 * Le message est celui que le filtre d'exceptions aurait produit : pas de trace
 * d'exécution, pas de détail d'infrastructure. Un flux SSE contourne le filtre
 * global — les en-têtes sont déjà partis — donc l'assainissement doit être fait
 * ici, explicitement.
 */
export const SseErrorEventSchema = z
  .object({
    type: z.literal('error'),
    analyzeId: z.uuid().nullable(),
    message: z.string().max(500),
  })
  .strict();

export const SseAnalyzeEventSchema = z.discriminatedUnion('type', [
  SseStartEventSchema,
  SseCheckEventSchema,
  SseCompleteEventSchema,
  SseErrorEventSchema,
]);

export type SseAnalyzeEvent = z.infer<typeof SseAnalyzeEventSchema>;

/** Événements d'un LOT — granularité : une page terminée. */
export const SseBatchStartEventSchema = z
  .object({
    type: z.literal('start'),
    batchId: z.uuid(),
    total: z.number().int().min(0),
  })
  .strict();

export const SseBatchPageEventSchema = z
  .object({
    type: z.literal('page'),
    batchId: z.uuid(),
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
    url: z.string().max(2048),
    ok: z.boolean(),
    /**
     * Rapport de CETTE page, transmis au fil de l'eau.
     *
     * Le client accumule pendant le scan au lieu de recevoir un bloc final de
     * plusieurs mégaoctets : sur un lot de deux cents pages, la différence
     * décide si le navigateur affiche quelque chose ou se fige.
     */
    report: AnalysisReportSchema.nullable(),
  })
  .strict();

export const SseBatchCompleteEventSchema = z
  .object({
    type: z.literal('complete'),
    batchId: z.uuid(),
    total: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    failed: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  })
  .strict();

export const SseBatchErrorEventSchema = z
  .object({
    type: z.literal('error'),
    batchId: z.uuid().nullable(),
    message: z.string().max(500),
  })
  .strict();

export const SseBatchEventSchema = z.discriminatedUnion('type', [
  SseBatchStartEventSchema,
  SseBatchPageEventSchema,
  SseBatchCompleteEventSchema,
  SseBatchErrorEventSchema,
]);

export type SseBatchEvent = z.infer<typeof SseBatchEventSchema>;
