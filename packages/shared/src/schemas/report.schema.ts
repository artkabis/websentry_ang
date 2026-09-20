import { z } from 'zod';
import { CheckStatusSchema } from './scan.schema.js';

/**
 * Rapport d'analyse — contrat partagé backend / frontend.
 *
 * C'est la sortie du moteur d'analyse et l'entrée de l'affichage. Le décrire en
 * schéma, et non en simple interface TypeScript, n'est pas un excès de zèle :
 * ce rapport est **sérialisé vers un worker**, **stocké en base**, puis **relu
 * des mois plus tard**. À chacune de ces frontières, une forme inattendue doit
 * être détectée là où elle apparaît, pas trois écrans plus loin.
 *
 * L'historique (module 3) conserve délibérément `report: z.unknown()` de son
 * côté : il restitue des rapports écrits par des versions antérieures du moteur,
 * et figer leur forme interdirait de faire évoluer le rapport sans rendre
 * illisibles les scans déjà stockés.
 */

export const PlatformSchema = z.enum(['duda', 'wordpress', 'generic']);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * Mode de rendu. `static` seulement pour l'instant : l'outil analyse le HTML
 * servi, sans navigateur sans tête — c'est ce qui lui permet de tenir sur un
 * hébergement mutualisé.
 */
export const RenderModeSchema = z.enum(['static', 'browser']);
export type RenderMode = z.infer<typeof RenderModeSchema>;

/**
 * Ancrage vers l'élément fautif dans la page réelle, via un fragment de texte
 * (`#:~:text=`). Ne vise que du **texte visible** ; `prefix`/`suffix` lèvent
 * l'ambiguïté quand le texte est court ou répété.
 */
export const CheckItemLocatorSchema = z
  .object({
    text: z.string().max(300),
    textEnd: z.string().max(300).optional(),
    prefix: z.string().max(300).optional(),
    suffix: z.string().max(300).optional(),
  })
  .strict();

export type CheckItemLocator = z.infer<typeof CheckItemLocatorSchema>;

/** Longueur maximale d'un extrait de source — au-delà, on transporte une page entière. */
export const MAX_SOURCE_LENGTH = 2000;

export const CheckItemSchema = z
  .object({
    key: z.string().max(80).optional(),
    label: z.string().max(500),
    value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]).optional(),
    status: CheckStatusSchema,
    detail: z.string().max(2000).optional(),
    locator: CheckItemLocatorSchema.optional(),
    /** Extrait du HTML fautif, tronqué — alimente la vue « code » de l'interface. */
    source: z.string().max(MAX_SOURCE_LENGTH).optional(),
  })
  .strict();

export type CheckItem = z.infer<typeof CheckItemSchema>;

// ── Cartographie des liens ───────────────────────────────────────────────────

export const LinkZoneSchema = z.enum([
  'nav',
  'header',
  'footer',
  'hero',
  'content',
  'sidebar',
  'cta',
  'shop',
  'unknown',
]);
export type LinkZone = z.infer<typeof LinkZoneSchema>;

export const LinkTypeSchema = z.enum([
  'text',
  'image',
  'button',
  'ctc',
  'ctm',
  'mixed',
  'container',
]);
export type LinkType = z.infer<typeof LinkTypeSchema>;

export const LinkEntrySchema = z
  .object({
    /** URL absolue résolue, ou valeur brute pour `tel:`, `mailto:`, `#`. */
    href: z.string().max(2048),
    /** Texte visible, ou `alt` de l'image quand le lien n'en porte pas. */
    anchor: z.string().max(500),
    zone: LinkZoneSchema,
    type: LinkTypeSchema,
    isInternal: z.boolean(),
    /** « cliquez ici », « en savoir plus »… — une ancre qui ne dit rien de la cible. */
    isGenericAnchor: z.boolean(),
    rel: z.string().max(200).optional(),
    targetIsAnchor: z.boolean(),
  })
  .strict();

export type LinkEntry = z.infer<typeof LinkEntrySchema>;

export const ContentLinkDetailSchema = z
  .object({
    url: z.string().max(2048),
    type: LinkTypeSchema,
    zone: LinkZoneSchema,
    anchor: z.string().max(500),
  })
  .strict();

export type ContentLinkDetail = z.infer<typeof ContentLinkDetailSchema>;

/**
 * Résolution HTTP d'un lien, redirections suivies.
 *
 * `reachable` couvre le 2xx final, la redirection vers un 2xx, et le blocage de
 * robot (403/429/999) : un lien que le site cible refuse de servir à un outil
 * n'est pas un lien mort, et le compter comme tel remplirait le rapport de faux
 * positifs sur les gros sites protégés.
 */
export const LinkResolutionSchema = z
  .object({
    url: z.string().max(2048),
    finalUrl: z.string().max(2048),
    reachable: z.boolean(),
    redirected: z.boolean(),
  })
  .strict();

export type LinkResolution = z.infer<typeof LinkResolutionSchema>;

// ── Résultat d'un critère ────────────────────────────────────────────────────

export const CheckResultSchema = z
  .object({
    checkId: z.string().max(80),
    checkTitle: z.string().max(200),
    globalScore: z.number().min(0).max(5),
    status: CheckStatusSchema,
    items: z.array(CheckItemSchema).max(2000),
    summary: z.string().max(2000),
    recommendations: z.array(z.string().max(1000)).max(50),

    // ── Sorties annexes, alimentées par quelques analyseurs seulement ────────
    /** Liens internes de contenu (hors nav/header/footer) — base de la détection des orphelines. */
    contentLinks: z.array(z.string().max(2048)).max(5000).optional(),
    /** Cibles d'un conteneur légal — servent à exclure les pages légales des orphelines. */
    legalLinks: z.array(z.string().max(2048)).max(500).optional(),
    contentLinkDetails: z.array(ContentLinkDetailSchema).max(5000).optional(),
    footerLinks: z.array(z.string().max(2048)).max(2000).optional(),
    linkMap: z.array(LinkEntrySchema).max(5000).optional(),
    /**
     * Liens de conteneur Duda (`data-link-on-container`) — navigation JS d'un bloc
     * parent cliquable. Purement INFORMATIF, et volontairement exclu de
     * `contentLinks` : un conteneur ne transmet pas de « jus » SEO, donc une page
     * qui n'est atteinte que par lui reste orpheline.
     */
    containerLinks: z.array(ContentLinkDetailSchema).max(5000).optional(),
    linkResolutions: z.array(LinkResolutionSchema).max(5000).optional(),
  })
  .strict();

export type CheckResult = z.infer<typeof CheckResultSchema>;

// ── Rapport ──────────────────────────────────────────────────────────────────

export const RedirectHopSchema = z
  .object({ url: z.string().max(2048), status: z.number().int().min(0).max(999) })
  .strict();

export type RedirectHop = z.infer<typeof RedirectHopSchema>;

/** Paramètres Duda extraits de `window.Parameters` — `null` si la page n'est pas Duda. */
export const DudaParamsSchema = z
  .object({
    homeUrl: z.string().max(2048).nullable(),
    accountUUID: z.string().max(200).nullable(),
    systemID: z.string().max(200).nullable(),
    siteAlias: z.string().max(255).nullable(),
    siteType: z.string().max(50).nullable(),
    publicationDate: z.string().max(50).nullable(),
    planID: z.string().max(50).nullable(),
    productId: z.string().max(50).nullable(),
    defaultLang: z.string().max(20).nullable(),
    isMultilingual: z.boolean().nullable(),
    gamme: z.string().max(50).nullable(),
    epj: z.string().max(100).nullable(),
    externalUid: z.string().max(200).nullable(),
    storePageAlias: z.string().max(255).nullable(),
    storePagesUrls: z.string().max(10_000).nullable(),
    isNewStore: z.boolean().nullable(),
    storePath: z.string().max(255).nullable(),
    storeId: z.string().max(200).nullable(),
    storeVersion: z.number().nullable(),
    storeBaseUrl: z.string().max(2048).nullable(),
  })
  .strict();

export type DudaParams = z.infer<typeof DudaParamsSchema>;

/**
 * En-têtes HTTP retenus dans le rapport.
 *
 * Liste FERMÉE, et c'est délibéré : un rapport est stocké puis relu par des
 * tiers, et recopier tous les en-têtes y ferait entrer des jetons de session,
 * des cookies ou des identifiants d'infrastructure sans que personne ne l'ait
 * décidé.
 */
export const REPORTED_HEADERS: readonly string[] = [
  'content-type',
  'cache-control',
  'x-robots-tag',
  'x-frame-options',
  'content-security-policy',
  'strict-transport-security',
  'last-modified',
  'etag',
  'server',
  'x-powered-by',
  'vary',
  'expires',
  'pragma',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'referrer-policy',
  'permissions-policy',
];

const REPORTED_HEADER_SET = new Set(REPORTED_HEADERS);

/** Ne garde du jeu d'en-têtes que ceux de la liste fermée, en minuscules. */
export function pickReportedHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (REPORTED_HEADER_SET.has(lower)) kept[lower] = value;
  }
  return kept;
}

export const AnalysisReportSchema = z
  .object({
    analyzeId: z.uuid(),
    url: z.string().max(2048),
    /** Titre de la page — `<title>`, ou `og:title` en repli. */
    title: z.string().max(1000),
    analyzedAt: z.string(),
    durationMs: z.number().int().min(0),
    globalScore: z.number().min(0).max(5),
    platform: PlatformSchema,
    renderMode: RenderModeSchema,
    /** Code HTTP FINAL, redirections suivies. */
    statusCode: z.number().int().min(0).max(999),
    ttfb: z.number().min(0),
    redirectChain: z.array(RedirectHopSchema).max(20),
    htmlSize: z.number().int().min(0),
    httpHeaders: z.record(z.string().max(100), z.string().max(4000)),
    dudaParams: DudaParamsSchema.nullable(),
    checks: z.record(z.string().max(80), CheckResultSchema),
  })
  .strict();

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
