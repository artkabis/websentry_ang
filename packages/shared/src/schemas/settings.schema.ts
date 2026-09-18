import { z } from 'zod';
import { MAX_CHECK_WEIGHT, MIN_CHECK_WEIGHT } from '../check-weights.js';

/**
 * Réglages d'analyse — repris à l'identique de la v1.
 *
 * Ce schéma est la source unique de vérité : l'API valide les écritures avec,
 * le frontend borne ses formulaires dessus, et les profils stockés en base sont
 * validés à la lecture comme à l'écriture.
 */

// ── Garde anti-pollution de prototype ────────────────────────────────────────

/**
 * Clés interdites dans un dictionnaire libre.
 *
 * `checkWeights` et `subCheckPolarity` sont des enregistrements à clés libres,
 * fusionnés plus tard dans des objets de configuration. Une clé `__proto__`
 * (ou `constructor`, `prototype`) y transformerait une simple écriture de
 * réglages en pollution de prototype affectant TOUT le processus. Zod accepte
 * ces clés par défaut — d'où ce filtre explicite.
 */
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Contrôle les clés BRUTES d'un dictionnaire, avant que Zod ne les filtre.
 *
 * `z.record` écarte SILENCIEUSEMENT toute clé qui ne satisfait pas son schéma de
 * clé. Le résultat est sûr — `__proto__` n'atteint jamais la sortie — mais deux
 * choses se perdent en route :
 *   • une tentative de pollution de prototype ne laisse aucune trace ;
 *   • un identifiant de critère mal orthographié disparaît sans le dire, et
 *     l'administrateur croit avoir enregistré un réglage qui n'existe pas.
 *
 * On inspecte donc l'entrée brute en amont, pour transformer ces deux cas en
 * erreurs explicites.
 */
function assertSafeRecordKeys(raw: unknown, ctx: z.RefinementCtx): unknown {
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

/** Motif d'identifiant de critère — partagé par le schéma et le contrôle brut. */
const CHECK_KEY_PATTERN = /^[A-Z0-9_]+(\.[a-z0-9_]+)?$/;

/** Identifiant de critère ou de sous-critère — jeu de caractères volontairement étroit. */
const CheckKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(CHECK_KEY_PATTERN, 'Identifiant de critère invalide');

// ── Règles par page ──────────────────────────────────────────────────────────

/** Bornes min/max d'une longueur de texte. */
const LengthRangeSchema = z
  .object({
    minLength: z.number().int().min(0).max(10_000).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const PageRuleSchema = z
  .object({
    label: z.string().min(1).max(120),
    patterns: z.array(z.string().max(500)).max(200),
    disabledChecks: z.array(CheckKeySchema).max(500).optional(),
    settings: z
      .object({
        content: z
          .object({
            minWords: z.number().int().min(0).max(100_000).optional(),
            warningWords: z.number().int().min(0).max(100_000).optional(),
          })
          .strict()
          .optional(),
        h1: LengthRangeSchema.optional(),
        h2: LengthRangeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PageRule = z.infer<typeof PageRuleSchema>;

// ── Réglages d'analyse ───────────────────────────────────────────────────────

/**
 * Mots-outils exclus de l'analyse des titres — défaut repris de la v1.
 *
 * Modifier cette liste change le score des titres sur TOUS les profils qui ne
 * la surchargent pas : elle fait partie du contrat de compatibilité.
 */
export const DEFAULT_EXCLUDED_WORDS: readonly string[] = [
  'le',
  'la',
  'les',
  'de',
  'du',
  'des',
  'un',
  'une',
  'et',
  'en',
  'au',
  'aux',
  'ce',
  'se',
  'sa',
  'son',
  'sur',
  'pour',
  'par',
  'avec',
  'dans',
  'qui',
];

/** Domaines dont les liens ne sont pas vérifiés (anti-bot, faux positifs connus). */
export const DEFAULT_EXCLUDED_DOMAINS: readonly string[] = [
  'mappy.com',
  'solocal.com',
  'sp.report-uri.com',
  'bloctel.gouv.fr',
  'logflare.app',
];

/**
 * Objet de base des réglages, AVANT contrôles croisés.
 *
 * Exposé séparément parce qu'un schéma raffiné (`.superRefine`) n'est plus un
 * objet : il n'offre ni `.partial()` ni `.extend()`. Une surcharge partielle de
 * réglages en a besoin — et l'obtenir autrement reviendrait à redéclarer la
 * forme une seconde fois, donc à la laisser diverger.
 */
export const AnalysisSettingsObjectSchema = z
  .object({
    meta: z
      .object({
        title: z
          .object({
            min: z.number().int().min(0).max(1000),
            max: z.number().int().min(1).max(1000),
          })
          .strict(),
        description: z
          .object({
            min: z.number().int().min(0).max(1000),
            max: z.number().int().min(1).max(1000),
          })
          .strict(),
      })
      .strict()
      .default(() => ({ title: { min: 50, max: 65 }, description: { min: 140, max: 156 } })),

    hn: z
      .object({
        minLength: z.number().int().min(0).max(1000),
        maxLength: z.number().int().min(1).max(1000),
        excludedWords: z.array(z.string().max(100)).max(1000),
      })
      .strict()
      .default(() => ({
        minLength: 50,
        maxLength: 90,
        excludedWords: [...DEFAULT_EXCLUDED_WORDS],
      })),

    bold: z
      .object({
        min: z.number().int().min(0).max(1000),
        max: z.number().int().min(1).max(1000),
        minParentWords: z.number().int().min(0).max(10_000),
      })
      .strict()
      .default(() => ({ min: 3, max: 5, minParentWords: 20 })),

    images: z
      .object({
        maxSizeBytes: z.number().int().min(0).max(1_000_000_000),
        warningThresholdBytes: z.number().int().min(0).max(1_000_000_000),
        maxRatio: z.number().min(0).max(1000),
      })
      .strict()
      .default(() => ({ maxSizeBytes: 317_435, warningThresholdBytes: 256_000, maxRatio: 3 })),

    links: z
      .object({
        timeout: z.number().int().min(0).max(600_000),
        excludedDomains: z.array(z.string().max(253)).max(1000),
      })
      .strict()
      .default(() => ({ timeout: 10_000, excludedDomains: [...DEFAULT_EXCLUDED_DOMAINS] })),

    content: z
      .object({
        minWords: z.number().int().min(0).max(100_000),
        warningWords: z.number().int().min(0).max(100_000),
      })
      .strict()
      .default(() => ({ minWords: 300, warningWords: 500 })),

    enabledChecks: z.array(CheckKeySchema).max(500).optional(),
    disabledChecks: z.array(CheckKeySchema).max(500).optional(),
    enabledSubChecks: z.array(CheckKeySchema).max(2000).optional(),
    informationalChecks: z.array(CheckKeySchema).max(500).optional(),

    /** Pondération par critère (0 = exclu du score, défaut 1). */
    checkWeights: z
      .preprocess(
        assertSafeRecordKeys,
        z.record(CheckKeySchema, z.number().min(MIN_CHECK_WEIGHT).max(MAX_CHECK_WEIGHT)),
      )
      .optional(),

    checksOrder: z.array(CheckKeySchema).max(500).optional(),
    detectRegressions: z.boolean().optional(),
    orphanExclusions: z.array(z.string().max(500)).max(1000).optional(),
    autoExcludeLegalOrphans: z.boolean().optional(),
    pageRules: z.array(PageRuleSchema).max(200).optional(),

    /** Inversion de polarité d'un sous-critère : l'absence devient l'état conforme. */
    subCheckPolarity: z
      .preprocess(assertSafeRecordKeys, z.record(CheckKeySchema, z.enum(['present', 'absent'])))
      .optional(),

    structuredData: z
      .object({ requireFiveImages: z.boolean().default(false) })
      .strict()
      .partial()
      .optional(),

    anchorText: z
      .object({
        enabled: z.boolean().default(true),
        concordanceThreshold: z.number().int().min(0).max(100).default(60),
        warningThreshold: z.number().int().min(0).max(100).default(35),
        maxLinksReported: z.number().int().min(1).max(100).default(20),
        ignoreZones: z
          .array(z.string().max(100))
          .max(100)
          .default(() => ['nav', 'header', 'footer']),
        excludeSelectors: z
          .array(z.string().max(500))
          .max(200)
          .default(() => []),
        excludeShopLinks: z.boolean().default(false),
        shopBasePath: z.string().max(500).default(''),
        companyName: z.string().max(200).optional(),
      })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

export const AnalysisSettingsSchema = AnalysisSettingsObjectSchema.superRefine((settings, ctx) => {
  // Un intervalle inversé passerait la validation champ par champ tout en
  // rendant le critère insatisfiable : aucune valeur ne peut être à la fois
  // ≥ min et ≤ max. On le refuse à la frontière plutôt que de laisser
  // l'analyse produire des résultats incompréhensibles.
  const ranges: Array<[string, number, number]> = [
    ['meta.title', settings.meta.title.min, settings.meta.title.max],
    ['meta.description', settings.meta.description.min, settings.meta.description.max],
    ['hn', settings.hn.minLength, settings.hn.maxLength],
    ['bold', settings.bold.min, settings.bold.max],
  ];

  for (const [path, min, max] of ranges) {
    if (min > max) {
      ctx.addIssue({
        code: 'custom',
        path: path.split('.'),
        message: `Intervalle inversé : le minimum (${min}) dépasse le maximum (${max})`,
      });
    }
  }

  // Le seuil d'avertissement doit précéder le seuil d'échec, sinon il ne se
  // déclencherait jamais.
  if (settings.images.warningThresholdBytes > settings.images.maxSizeBytes) {
    ctx.addIssue({
      code: 'custom',
      path: ['images', 'warningThresholdBytes'],
      message: "Le seuil d'avertissement doit être inférieur ou égal au poids maximal",
    });
  }

  if (settings.content.minWords > settings.content.warningWords) {
    ctx.addIssue({
      code: 'custom',
      path: ['content', 'warningWords'],
      message: "Le seuil d'avertissement doit être supérieur ou égal au minimum de mots",
    });
  }
});

export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>;

/** Réglages par défaut — obtenus en laissant Zod appliquer ses valeurs de repli. */
export function defaultAnalysisSettings(): AnalysisSettings {
  return AnalysisSettingsSchema.parse({});
}
