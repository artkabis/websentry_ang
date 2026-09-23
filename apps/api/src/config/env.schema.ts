import { z } from 'zod';

/**
 * Schéma d'environnement — validé AU DÉMARRAGE, avant tout binding réseau.
 *
 * Une variable manquante ou aberrante fait échouer le boot : le serveur ne
 * démarre jamais dans un état à moitié configuré (pas de secret JWT vide,
 * pas de cookie non-Secure en production).
 */

/** Entier positif depuis une variable d'environnement (toujours une chaîne). */
const intFromEnv = (fallback: number, min = 0) =>
  z.coerce.number().int().min(min).catch(fallback).default(fallback);

/** Longueur minimale du secret JWT : 32 octets d'entropie pour HS256. */
const JWT_SECRET_MIN_LENGTH = 32;

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(3031, 1),
    HOST: z.string().default('0.0.0.0'),

    /** Origine(s) autorisée(s) par CORS — liste séparée par des virgules. */
    CORS_ORIGIN: z.string().default('http://localhost:4200'),

    // ── Authentification ────────────────────────────────────────────────────
    /**
     * Secret HS256. Aucune valeur par défaut : un secret deviné = usurpation
     * d'identité totale. Le boot échoue s'il est absent ou trop court.
     */
    JWT_SECRET: z
      .string()
      .min(
        JWT_SECRET_MIN_LENGTH,
        `JWT_SECRET doit faire au moins ${JWT_SECRET_MIN_LENGTH} caractères`,
      ),

    /** TTL de l'access token (secondes). Plafonné à 15 min — cf. AuthService. */
    ACCESS_TOKEN_TTL: intFromEnv(900, 60),
    /** TTL du refresh token (secondes). 7 jours par défaut. */
    REFRESH_TOKEN_TTL: intFromEnv(604800, 60),

    /** Verrouillage de compte : N échecs consécutifs, puis blocage temporaire. */
    LOGIN_MAX_ATTEMPTS: intFromEnv(5, 1),
    LOGIN_LOCKOUT_SECONDS: intFromEnv(900, 1),

    // ── Base de données MariaDB ─────────────────────────────────────────────
    DB_HOST: z.string().default('localhost'),
    DB_PORT: intFromEnv(3306, 1),
    DB_NAME: z.string().default('websentry'),
    DB_USER: z.string().default('websentry'),
    DB_PASSWORD: z.string().default(''),
    DB_CONNECTION_LIMIT: intFromEnv(10, 1),
    /** `false` désactive toute connexion DB (tests unitaires, mode dégradé). */
    DB_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform(v => v === 'true'),

    // ── Sortie HTTP (analyseurs) ────────────────────────────────────────────
    FETCH_USER_AGENT: z
      .string()
      .default('Mozilla/5.0 (compatible; WebSentry/2.0; +https://websentry.artkabis.fr/bot)'),
    FETCH_TIMEOUT_MS: intFromEnv(15000, 1000),

    // ── Rétention de l'historique des scans ─────────────────────────────────
    /**
     * Âge à partir duquel un rapport est compressé (jours). Sept jours couvrent
     * la fenêtre pendant laquelle un rapport est encore relu au quotidien ;
     * au-delà, la consultation devient occasionnelle et la décompression à la
     * demande coûte moins cher que le stockage en clair.
     */
    SCAN_COMPRESS_AFTER_DAYS: intFromEnv(7, 1),
    /**
     * Âge à partir duquel le rapport complet est purgé (jours). Le résumé des
     * critères, lui, n'est JAMAIS purgé : c'est ce qui permet de comparer deux
     * scans anciens longtemps après que leurs rapports ont disparu.
     */
    SCAN_PURGE_AFTER_DAYS: intFromEnv(180, 1),
    /** Lignes traitées par passage du travail de fond — borne les verrous pris. */
    SCAN_RETENTION_BATCH: intFromEnv(500, 1),
    /** `false` désactive entièrement le travail de fond de rétention. */
    SCAN_RETENTION_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform(v => v === 'true'),

    // ── Moteur d'analyse ────────────────────────────────────────────────────
    /**
     * `false` exécute les analyses sur le thread principal.
     *
     * Le repli existe pour les hébergements qui interdisent `worker_threads` ou
     * contraignent la mémoire : mieux vaut analyser lentement que pas du tout.
     */
    ANALYSIS_WORKERS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform(v => v === 'true'),
    /** 0 = automatique : un thread de moins que de cœurs disponibles. */
    ANALYSIS_MAX_WORKERS: intFromEnv(0, 0),
    /** Pages analysées en parallèle dans un lot — borne l'egress simultané. */
    ANALYSIS_BATCH_CONCURRENCY: intFromEnv(4, 1),

    // ── Messagerie ──────────────────────────────────────────────────────────
    /**
     * Dossier des pièces jointes — HORS de l'arborescence servie.
     *
     * Aucune route ne sert de fichier statique : le contenu est lu par le
     * service et renvoyé sous un identifiant, jamais sous un chemin. Le dossier
     * peut donc vivre où l'exploitant veut, y compris sur un volume monté.
     */
    MESSAGE_UPLOADS_DIR: z.string().min(1).default('./data/pieces-jointes'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    // En production, un secret de démonstration ne doit jamais passer.
    if (
      env.NODE_ENV === 'production' &&
      /^(change|test|dev|secret|password)/i.test(env.JWT_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET ressemble à une valeur de démonstration — interdit en production',
      });
    }
    // Le mode « sans base » porte des comptes locaux dans un fichier : c'est un
    // outil de développement, et il n'a rien à faire en production, où les
    // comptes, leurs rangs et leurs révocations vivent en base.
    if (env.NODE_ENV === 'production' && !env.DB_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_ENABLED'],
        message: 'DB_ENABLED=false est un mode de développement — interdit en production',
      });
    }
    // Un refresh plus court que l'access rendrait la rotation inopérante.
    if (env.REFRESH_TOKEN_TTL <= env.ACCESS_TOKEN_TTL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_TTL'],
        message: 'REFRESH_TOKEN_TTL doit être strictement supérieur à ACCESS_TOKEN_TTL',
      });
    }
    // Purger avant d'avoir compressé rend la compression inutile : le défaut ne
    // se verrait qu'à la facture de stockage, des mois plus tard.
    if (env.SCAN_PURGE_AFTER_DAYS <= env.SCAN_COMPRESS_AFTER_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SCAN_PURGE_AFTER_DAYS'],
        message: 'SCAN_PURGE_AFTER_DAYS doit être strictement supérieur à SCAN_COMPRESS_AFTER_DAYS',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Valide `process.env`. Lève une erreur agrégée listant TOUTES les variables
 * fautives d'un coup — on ne fait pas redémarrer l'opérateur une fois par erreur.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map(i => `  - ${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}
