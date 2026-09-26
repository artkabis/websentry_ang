import * as z from 'zod';

/**
 * Historique des scans — contrat partagé backend / frontend.
 *
 * Le modèle est HIÉRARCHIQUE, repris tel quel de la base v1 en production :
 *
 *   site           un couple (domaine, gamme) — identité stable dans le temps
 *     └─ session   un lancement d'audit (scan unique ou batch)
 *          └─ page  une URL analysée, qui porte le rapport complet
 *
 * Trois niveaux, trois vues : la liste plate des pages (recherche fine), la
 * liste des sites (« où en est ce client ? »), et le détail d'une session.
 */

// ── Garde anti-pollution de prototype ────────────────────────────────────────

const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Motif d'identifiant de critère — aligné sur celui des réglages. */
const CHECK_KEY_PATTERN = /^[A-Z0-9_]+(\.[a-z0-9_]+)?$/;

/**
 * Inspecte les clés BRUTES d'un résumé de critères avant que Zod ne les filtre.
 *
 * `check_summary` vient de la base : il a été écrit par une version antérieure
 * de l'application, potentiellement avec des identifiants qui n'existent plus.
 * `z.record` les écarterait en silence ; on préfère une erreur nommée, que le
 * service traduira en repli explicite plutôt qu'en résumé amputé sans trace.
 */
function assertSafeSummaryKeys(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: `Clé interdite : ${key}` });
      continue;
    }
    if (!CHECK_KEY_PATTERN.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Identifiant de critère inconnu : ${key}`,
      });
    }
  }
  return raw;
}

// ── Briques élémentaires ─────────────────────────────────────────────────────

/**
 * Statut d'un critère.
 *
 * `na` (non applicable) n'est pas un mauvais résultat : c'est l'absence de
 * résultat. La comparaison l'ignore dans les deux sens (cf. `scan-comparison`).
 */
export const CheckStatusSchema = z.enum(['pass', 'info', 'warning', 'fail', 'na']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** Résumé léger d'un scan : un statut par critère. Toujours présent en base. */
export const CheckSummarySchema = z.preprocess(
  assertSafeSummaryKeys,
  z.record(z.string().regex(CHECK_KEY_PATTERN), CheckStatusSchema),
);
export type CheckSummary = Record<string, CheckStatus>;

/**
 * Domaine d'un site.
 *
 * Peut dépasser un simple hostname : les URL de prévisualisation Duda partagent
 * un hôte commun, et l'identité du site vit alors dans le chemin
 * (`host/site/{uuid}`). Le champ porte donc la forme dérivée, pas l'hôte brut.
 */
export const ScanDomainSchema = z.string().min(1).max(255);

/** Identifiant de site, de session ou de page — UUID v4 généré par l'application. */
export const ScanUuidSchema = z.uuid();

/** Score global, sur l'échelle 0–5 de l'outil. `null` quand la page n'a pas pu être notée. */
export const ScoreSchema = z.number().min(0).max(5);

/** Métadonnées Duda d'un site — toutes facultatives, la plateforme ne les garantit pas. */
export const SiteMetadataSchema = z
  .object({
    siteAlias: z.string().max(255).nullable().optional(),
    isMultilingual: z.boolean().nullable().optional(),
    isEcommerce: z.boolean().nullable().optional(),
    storePath: z.string().max(255).nullable().optional(),
    siteType: z.string().max(50).nullable().optional(),
    defaultLang: z.string().max(20).nullable().optional(),
    planId: z.string().max(50).nullable().optional(),
  })
  .strict();

export type SiteMetadata = z.infer<typeof SiteMetadataSchema>;

/**
 * État du rapport complet d'une page — le stockage est à trois étages.
 *
 * Distinguer `purged` de « jamais stocké » est ce qui permet de répondre
 * « ce rapport a été purgé le … » au lieu d'un 404 trompeur : le scan existe,
 * c'est son rapport que la rétention a effacé.
 */
export const ReportStateSchema = z.enum(['inline', 'compressed', 'purged']);
export type ReportState = z.infer<typeof ReportStateSchema>;

// ── Page analysée ────────────────────────────────────────────────────────────

export const ScanPageSchema = z
  .object({
    id: ScanUuidSchema,
    sessionId: ScanUuidSchema,
    url: z.string().max(2048),
    domain: ScanDomainSchema,
    gamme: z.string().max(50).nullable(),
    epj: z.string().max(100).nullable(),
    platform: z.string().max(50).nullable(),
    globalScore: ScoreSchema.nullable(),
    statusCode: z.number().int().min(0).max(999).nullable(),
    analyzedAt: z.string(),
    durationMs: z.number().int().min(0).nullable(),
    checkSummary: CheckSummarySchema,
    metadata: SiteMetadataSchema.nullable(),
    launchedBy: z.string().max(64).nullable(),
    reportState: ReportStateSchema,
  })
  .strict();

export type ScanPage = z.infer<typeof ScanPageSchema>;

// ── Recherche ────────────────────────────────────────────────────────────────

/**
 * Borne de date acceptée en filtre.
 *
 * Deux formes coexistent chez les appelants : la date seule (`2026-06-04`),
 * saisie par un humain dans un champ date, et l'horodatage ISO complet, produit
 * par un lien partagé ou un client programmatique. La v1 déclarait accepter les
 * deux mais concaténait ` 00:00:00` à la valeur reçue sans distinguer : un ISO
 * complet produisait `2026-06-04T10:00:00Z 00:00:00`, que MariaDB coerce en
 * silence — le filtre était alors ignoré et la recherche renvoyait tout.
 * On accepte donc les deux formes EXPLICITEMENT ; la conversion en borne est le
 * travail du service, qui sait de quel côté de l'intervalle elle tombe.
 */
export const DateBoundSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ'),
  z.iso.datetime({ offset: true }),
]);

/**
 * Colonnes de tri autorisées.
 *
 * Liste FERMÉE : le nom de colonne correspondant est choisi par correspondance
 * côté repository, jamais interpolé depuis l'entrée. Un `ORDER BY` construit
 * par concaténation serait le seul endroit du module où une injection SQL
 * resterait possible, les valeurs étant partout ailleurs paramétrées.
 */
export const ScanSortSchema = z.enum(['analyzedAt', 'score', 'domain', 'url']);
export type ScanSort = z.infer<typeof ScanSortSchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const ScanSearchQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    domain: z.string().max(255).optional(),
    gamme: z.string().max(50).optional(),
    epj: z.string().max(100).optional(),
    scoreMin: z.coerce.number().min(0).max(5).optional(),
    scoreMax: z.coerce.number().min(0).max(5).optional(),
    dateFrom: DateBoundSchema.optional(),
    dateTo: DateBoundSchema.optional(),
    sessionId: ScanUuidSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    sort: ScanSortSchema.default('analyzedAt'),
    order: SortOrderSchema.default('desc'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Un intervalle inversé ne renvoie rien : autant le dire plutôt que de
    // laisser l'utilisateur conclure que l'historique est vide.
    if (value.scoreMin != null && value.scoreMax != null && value.scoreMin > value.scoreMax) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoreMin'],
        message: 'Le score minimum dépasse le score maximum',
      });
    }
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateFrom'],
        message: 'La date de début est postérieure à la date de fin',
      });
    }
  });

export type ScanSearchQuery = z.infer<typeof ScanSearchQuerySchema>;

/**
 * Enveloppe de pagination commune aux listes de l'historique.
 *
 * Les deux listes l'ÉTENDENT plutôt que de recevoir leur nom de champ en
 * paramètre : une clé calculée (`[key]: z.array(...)`) se réduirait à une
 * signature d'index une fois inférée, et `result.scans` serait typé
 * `number | ScanPage[]` — un type qui ne protège plus de rien, ni ici ni dans
 * le client Angular qui le consomme.
 */
const PaginationSchema = z.object({
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  pages: z.number().int().min(0),
});

export const ScanPageListSchema = PaginationSchema.extend({
  scans: z.array(ScanPageSchema),
}).strict();
export type ScanPageList = z.infer<typeof ScanPageListSchema>;

// ── Vue par site ─────────────────────────────────────────────────────────────

export const SiteSummarySchema = z
  .object({
    siteId: ScanUuidSchema,
    domain: ScanDomainSchema,
    gamme: z.string().max(50).nullable(),
    epj: z.string().max(100).nullable(),
    /** Session la plus récente du site — `null` pour un site sans aucune session. */
    lastSessionId: ScanUuidSchema.nullable(),
    pageCount: z.number().int().min(0),
    avgScore: ScoreSchema.nullable(),
    minScore: ScoreSchema.nullable(),
    maxScore: ScoreSchema.nullable(),
    lastScan: z.string(),
    sessionCount: z.number().int().min(0),
    launchedBy: z.string().max(64).nullable(),
    metadata: SiteMetadataSchema.nullable(),
  })
  .strict();

export type SiteSummary = z.infer<typeof SiteSummarySchema>;

export const SiteListSchema = PaginationSchema.extend({
  sites: z.array(SiteSummarySchema),
}).strict();
export type SiteList = z.infer<typeof SiteListSchema>;

/** Une session d'un site, telle que listée dans l'historique du site. */
export const SiteSessionSchema = z
  .object({
    sessionId: ScanUuidSchema,
    pageCount: z.number().int().min(0),
    avgScore: ScoreSchema.nullable(),
    minScore: ScoreSchema.nullable(),
    maxScore: ScoreSchema.nullable(),
    analyzedAt: z.string(),
    durationMs: z.number().int().min(0).nullable(),
    launchedBy: z.string().max(64).nullable(),
  })
  .strict();

export type SiteSession = z.infer<typeof SiteSessionSchema>;

export const SiteSessionListSchema = z.array(SiteSessionSchema);

/**
 * Sélection d'un site par ses coordonnées, depuis une query string.
 *
 * `gamme` absente et `gamme=` vide désignent la MÊME chose — le site sans gamme
 * — parce qu'un formulaire HTML dont le champ n'est pas rempli envoie la seconde
 * forme. Les traiter différemment ferait échouer la recherche sur un site sans
 * gamme dès qu'elle passe par l'interface plutôt que par un lien construit à la
 * main.
 */
export const SiteSelectorSchema = z
  .object({
    domain: ScanDomainSchema,
    gamme: z
      .string()
      .max(50)
      .optional()
      .transform(value => (value == null || value === '' ? null : value)),
  })
  .strict();

export type SiteSelector = z.infer<typeof SiteSelectorSchema>;

// ── Détail d'une session ─────────────────────────────────────────────────────

/** Réglages actifs au moment du scan — ce qui rend un résultat ancien interprétable. */
export const ProfileSnapshotSchema = z
  .object({
    profile: z.string().max(50).nullable().optional(),
    enabledChecks: z.array(z.string().max(80)).max(500),
    enabledSubChecks: z.array(z.string().max(80)).max(2000),
    informationalChecks: z.array(z.string().max(80)).max(500).optional(),
  })
  .strict();

export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

/**
 * Une page dans le détail d'une session.
 *
 * `report` est le rapport d'analyse brut. Sa forme appartient au module
 * d'analyse ; l'historique n'a pas à la connaître pour le restituer, et la
 * figer ici interdirait de faire évoluer le rapport sans casser la relecture
 * des scans déjà stockés.
 */
export const SessionPageSchema = z
  .object({
    id: ScanUuidSchema,
    url: z.string().max(2048),
    globalScore: ScoreSchema.nullable(),
    statusCode: z.number().int().min(0).max(999).nullable(),
    analyzedAt: z.string(),
    checkSummary: CheckSummarySchema,
    reportState: ReportStateSchema,
    report: z.unknown().nullable(),
    /** Renseigné quand le rapport existe mais n'a pas pu être relu. */
    error: z.string().max(200).nullable(),
  })
  .strict();

export type SessionPage = z.infer<typeof SessionPageSchema>;

/** Au-delà, une session est restituée tronquée — un batch sitemap peut compter des milliers de pages. */
export const SESSION_PAGE_LIMIT = 200;

export const SessionReportSchema = z
  .object({
    sessionId: ScanUuidSchema,
    siteId: ScanUuidSchema,
    domain: ScanDomainSchema,
    gamme: z.string().max(50).nullable(),
    epj: z.string().max(100).nullable(),
    platform: z.string().max(50).nullable(),
    launchedBy: z.string().max(64).nullable(),
    analyzedAt: z.string(),
    durationMs: z.number().int().min(0).nullable(),
    pageCount: z.number().int().min(0),
    avgScore: ScoreSchema.nullable(),
    minScore: ScoreSchema.nullable(),
    maxScore: ScoreSchema.nullable(),
    /** `true` quand la session compte plus de `SESSION_PAGE_LIMIT` pages. */
    truncated: z.boolean(),
    profileSnapshot: ProfileSnapshotSchema.nullable(),
    pages: z.array(SessionPageSchema),
  })
  .strict();

export type SessionReport = z.infer<typeof SessionReportSchema>;

// ── Statistiques ─────────────────────────────────────────────────────────────

export const ScanStatsSchema = z
  .object({
    total: z.number().int().min(0),
    sites: z.number().int().min(0),
    sessions: z.number().int().min(0),
    inline: z.number().int().min(0),
    compressed: z.number().int().min(0),
    purged: z.number().int().min(0),
    avgScore: ScoreSchema.nullable(),
    oldest: z.string().nullable(),
    newest: z.string().nullable(),
    storageBytesGz: z.number().int().min(0),
    byGamme: z.array(
      z
        .object({
          gamme: z.string().max(50),
          count: z.number().int().min(0),
          avgScore: ScoreSchema.nullable(),
        })
        .strict(),
    ),
    scoreDistribution: z
      .object({
        good: z.number().int().min(0),
        warning: z.number().int().min(0),
        critical: z.number().int().min(0),
        unknown: z.number().int().min(0),
      })
      .strict(),
    topDomains: z.array(
      z
        .object({
          domain: ScanDomainSchema,
          count: z.number().int().min(0),
          avgScore: ScoreSchema.nullable(),
        })
        .strict(),
    ),
    /** Instant du calcul — les statistiques sont servies depuis un cache court. */
    computedAt: z.string(),
  })
  .strict();

export type ScanStats = z.infer<typeof ScanStatsSchema>;

// ── Suppression ──────────────────────────────────────────────────────────────

export const DeleteResultSchema = z.object({ deleted: z.number().int().min(0) }).strict();
export type DeleteResult = z.infer<typeof DeleteResultSchema>;

/** Suppression en masse — bornée pour qu'une requête reste analysable et annulable. */
export const MAX_BULK_DELETE = 200;

export const BulkDeleteSchema = z
  .object({
    ids: z.array(ScanUuidSchema).min(1).max(MAX_BULK_DELETE),
  })
  .strict();

export type BulkDelete = z.infer<typeof BulkDeleteSchema>;

export const SiteDeleteSchema = z
  .object({
    domain: ScanDomainSchema,
    /**
     * `null` est une valeur SIGNIFIANTE : elle désigne le site sans gamme, et non
     * « toutes gammes ». Confondre les deux effacerait bien plus que demandé —
     * d'où l'exigence du champ, jamais son absence.
     */
    gamme: z.string().max(50).nullable(),
  })
  .strict();

export type SiteDelete = z.infer<typeof SiteDeleteSchema>;

// ── Rétention ────────────────────────────────────────────────────────────────

export const RetentionResultSchema = z
  .object({
    compressed: z.number().int().min(0),
    purged: z.number().int().min(0),
    /** Entrées de corbeille échues, effacées définitivement par ce passage. */
    trashPurged: z.number().int().min(0),
    /** Lignes restant à traiter — non nul quand le passage a atteint sa borne. */
    remaining: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  })
  .strict();

export type RetentionResult = z.infer<typeof RetentionResultSchema>;

// ── Ingestion ────────────────────────────────────────────────────────────────

/**
 * Contrat d'écriture de l'historique.
 *
 * Aucun endpoint HTTP ne l'expose : l'historique n'est pas alimenté depuis
 * l'extérieur, mais par le module d'analyse, en process. Le définir ici malgré
 * tout donne au module 3 une frontière testable sans dépendre de la forme du
 * rapport d'analyse, qui appartient au module 4 et n'est pas encore portée.
 */
export const ScanIngestPageSchema = z
  .object({
    url: z.url().max(2048),
    globalScore: ScoreSchema.nullable(),
    statusCode: z.number().int().min(0).max(999).nullable(),
    analyzedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().int().min(0).nullable(),
    checkSummary: CheckSummarySchema,
    /** Rapport complet sérialisable. `null` quand l'analyse a échoué sur cette page. */
    report: z.unknown().nullable(),
  })
  .strict();

export type ScanIngestPage = z.infer<typeof ScanIngestPageSchema>;

/** Au-delà, une session d'ingestion est refusée plutôt que tronquée en silence. */
export const MAX_INGEST_PAGES = 5000;

export const ScanIngestSchema = z
  .object({
    /** Identifiant de la session — celui du lancement, pour qu'un batch reste un tout. */
    sessionId: ScanUuidSchema,
    domain: ScanDomainSchema,
    gamme: z.string().max(50).nullable(),
    epj: z.string().max(100).nullable(),
    platform: z.string().max(50).nullable(),
    siteAlias: z.string().max(255).nullable(),
    metadata: SiteMetadataSchema.nullable(),
    launchedBy: z.string().max(64).nullable(),
    durationMs: z.number().int().min(0).nullable(),
    profileSnapshot: ProfileSnapshotSchema.nullable(),
    pages: z.array(ScanIngestPageSchema).min(1).max(MAX_INGEST_PAGES),
  })
  .strict();

export type ScanIngest = z.infer<typeof ScanIngestSchema>;

/**
 * Clé d'identité d'un site — `domaine|gamme`, gamme absente → `domaine|`.
 *
 * La base en fait une colonne générée UNIQUE. La raison est subtile : un
 * `UNIQUE (domain, gamme)` laisserait passer autant de lignes `gamme IS NULL`
 * qu'on veut, deux NULL n'étant jamais égaux en SQL. Le site « sans gamme »
 * serait alors dupliqué à chaque scan.
 */
export function siteIdentityKey(domain: string, gamme: string | null): string {
  return `${domain}|${gamme ?? ''}`;
}
