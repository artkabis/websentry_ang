import {
  SsrfBlockedError,
  type SafeFetchResult,
  type SsrfService,
} from '../security/ssrf.service.js';

/**
 * Sonde réseau des analyseurs.
 *
 * Cinq critères doivent contacter des ressources distantes : poids des images,
 * liens cassés, images dupliquées, données des mentions légales, robots.txt.
 * Toutes ces URL viennent du DOM d'une page TIERCE — c'est exactement le cas
 * que la politique SSRF existe pour traiter. La sonde est donc la SEULE porte
 * de sortie offerte à un analyseur : elle ne prend pas de `dispatcher`, ne
 * laisse pas passer d'en-têtes arbitraires, et ne rend jamais un corps brut.
 *
 * Elle ne lève pas non plus. Un analyseur reçoit un résultat décrivant
 * l'échec ; sans cela, une URL injoignable ferait tomber le critère entier
 * alors que c'est précisément ce qu'il est censé constater.
 */

/** Issue d'une vérification — jamais une exception. */
export interface ProbeResult {
  url: string;
  /** Statut HTTP final, `null` si la requête n'a pas abouti. */
  status: number | null;
  ok: boolean;
  redirected: boolean;
  finalUrl: string;
  /** `Content-Length` exploitable, `null` si absent ou non numérique. */
  contentLength: number | null;
  contentType: string | null;
  /** Renseigné quand la requête a échoué — message assaini, jamais la cause brute. */
  error?: string;
  /** Vrai quand c'est la politique SSRF qui a refusé, pas le réseau. */
  blocked?: boolean;
}

export interface NetworkProbe {
  /** Vérifie une URL (HEAD, repli GET si la méthode est refusée). */
  check(url: string): Promise<ProbeResult>;
  /** Vérifie plusieurs URL avec un pool continu, dans l'ordre d'entrée. */
  checkMany(urls: readonly string[]): Promise<ProbeResult[]>;
  /** Récupère un corps texte borné — robots.txt, page de mentions légales. */
  fetchText(url: string, maxBytes?: number): Promise<{ result: ProbeResult; body: string | null }>;
  /** Requêtes encore disponibles pour cette analyse. */
  readonly remaining: number;
}

/**
 * En-têtes de navigation directe.
 *
 * Repris de la v1, et pour la même raison : sans eux, les WAF répondent 403 à
 * une requête qui n'a rien d'hostile, et le rapport annonce des liens cassés
 * qui ne le sont pas. On imite un navigateur, on ne contourne aucune
 * protection — une page réellement interdite reste interdite.
 */
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

/**
 * Statuts pour lesquels un repli GET a du sens.
 *
 * La v1 ne réessayait que sur 405. Beaucoup de serveurs répondent pourtant 403
 * ou 501 à un HEAD parfaitement légitime, et la v1 comptait donc ces URL comme
 * cassées. On ne réessaie NI sur 404 NI sur 5xx : la réponse y est déjà la
 * vérité, et doubler les requêtes sur un site en panne l'enfoncerait.
 */
const RETRY_WITH_GET: ReadonlySet<number> = new Set([403, 405, 501]);

/** Requêtes sortantes autorisées pour UNE analyse. */
export const DEFAULT_REQUEST_BUDGET = 200;
/** Requêtes simultanées — au-delà, on martèle le site audité. */
export const DEFAULT_CONCURRENCY = 5;
/** Durée de validité d'un résultat mémorisé. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Bornes du cache, pour un thread qui vit longtemps. */
const CACHE_MAX_ENTRIES = 5000;
/** Plafond par défaut d'un corps texte lu par un analyseur. */
const DEFAULT_TEXT_BYTES = 512 * 1024;

export interface NetworkProbeOptions {
  timeoutMs?: number;
  /** Requêtes sortantes autorisées pour cette analyse. */
  budget?: number;
  concurrency?: number;
}

/** Cache partagé par le processus — une image de CDN est vue à chaque page. */
interface CacheEntry {
  result: ProbeResult;
  ts: number;
}
const sharedCache = new Map<string, CacheEntry>();

/** Vide le cache de sonde — réservé aux tests et aux purges explicites. */
export function clearProbeCache(): void {
  sharedCache.clear();
}

export class SsrfNetworkProbe implements NetworkProbe {
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private budget: number;

  constructor(
    private readonly ssrf: Pick<SsrfService, 'safeFetch' | 'readTextCapped'>,
    options: NetworkProbeOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.budget = options.budget ?? DEFAULT_REQUEST_BUDGET;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  get remaining(): number {
    return this.budget;
  }

  async check(url: string): Promise<ProbeResult> {
    const cached = cacheGet(url);
    if (cached) return cached;

    // Le budget est décompté AVANT la requête : une page hostile listant mille
    // liens ne doit pas pouvoir se servir du serveur comme d'un amplificateur.
    if (this.budget <= 0) return exhausted(url);
    this.budget -= 1;

    const result = await this.perform(url);
    cacheSet(url, result);
    return result;
  }

  /**
   * Pool CONTINU : un emplacement libéré repart aussitôt.
   *
   * Des lots séquentiels attendraient l'URL la plus lente de chaque lot — sur
   * cinquante liens dont un expire, cela ajoute le délai d'expiration entier.
   */
  async checkMany(urls: readonly string[]): Promise<ProbeResult[]> {
    if (urls.length === 0) return [];

    const results = new Array<ProbeResult>(urls.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < urls.length) {
        const index = next++;
        const url = urls[index];
        // `noUncheckedIndexedAccess` : l'indice vient de la longueur, mais le
        // type ne le sait pas.
        results[index] = url ? await this.check(url) : exhausted('');
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, urls.length) }, () => worker()),
    );
    return results;
  }

  async fetchText(
    url: string,
    maxBytes = DEFAULT_TEXT_BYTES,
  ): Promise<{ result: ProbeResult; body: string | null }> {
    if (this.budget <= 0) return { result: exhausted(url), body: null };
    this.budget -= 1;

    try {
      const fetched = await this.ssrf.safeFetch(url, {
        method: 'GET',
        headers: { ...BROWSER_HEADERS },
        timeoutMs: this.timeoutMs,
      });

      try {
        const body = await this.ssrf.readTextCapped(fetched.response, maxBytes);
        return { result: describe(url, fetched), body };
      } finally {
        fetched.dispose();
      }
    } catch (err) {
      return { result: failure(url, err), body: null };
    }
  }

  private async perform(url: string): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const head = await this.ssrf.safeFetch(url, {
        method: 'HEAD',
        headers: { ...BROWSER_HEADERS },
        timeoutMs: this.timeoutMs,
      });
      head.dispose();

      if (!RETRY_WITH_GET.has(head.response.status)) return describe(url, head);

      // Le serveur refuse la méthode, pas la ressource : on redemande en GET
      // avec le temps qu'il reste, sans jamais descendre sous trois secondes.
      const elapsed = Date.now() - started;
      const get = await this.ssrf.safeFetch(url, {
        method: 'GET',
        headers: { ...BROWSER_HEADERS },
        timeoutMs: Math.max(this.timeoutMs - elapsed, 3_000),
      });
      get.dispose();
      return describe(url, get);
    } catch (err) {
      return failure(url, err);
    }
  }
}

function describe(url: string, fetched: SafeFetchResult): ProbeResult {
  return {
    url,
    status: fetched.response.status,
    ok: fetched.response.ok,
    redirected: fetched.redirected,
    finalUrl: fetched.finalUrl,
    contentLength: parseContentLength(fetched.response.headers.get('content-length')),
    contentType: fetched.response.headers.get('content-type'),
  };
}

/**
 * `Number('')` vaut 0 et `Number('abc')` vaut NaN : les deux se propageraient
 * dans les comparaisons de poids d'image, la première en annonçant une image
 * de zéro octet, la seconde en rendant toute comparaison fausse sans erreur.
 */
function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Message d'échec choisi PAR TYPE, jamais recopié de l'exception.
 *
 * Un rapport est relu par des comptes qui n'ont pas à connaître les hôtes
 * internes ni l'arborescence du serveur, et une erreur réseau d'undici en dit
 * beaucoup plus que nécessaire.
 */
function failure(url: string, err: unknown): ProbeResult {
  const blocked = err instanceof SsrfBlockedError;
  const timedOut =
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

  return {
    url,
    status: null,
    ok: false,
    redirected: false,
    finalUrl: url,
    contentLength: null,
    contentType: null,
    blocked,
    error: blocked
      ? 'Adresse refusée par la politique de sécurité'
      : timedOut
        ? 'Délai dépassé'
        : 'Hôte injoignable',
  };
}

function exhausted(url: string): ProbeResult {
  return {
    url,
    status: null,
    ok: false,
    redirected: false,
    finalUrl: url,
    contentLength: null,
    contentType: null,
    error: 'Quota de vérifications atteint pour cette analyse',
  };
}

function cacheGet(url: string): ProbeResult | null {
  const hit = sharedCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    sharedCache.delete(url);
    return null;
  }
  return hit.result;
}

function cacheSet(url: string, result: ProbeResult): void {
  // Un quota épuisé n'est pas une propriété de l'URL : le mémoriser ferait
  // échouer la même URL lors de l'analyse suivante, qui a son propre quota.
  if (result.error?.startsWith('Quota')) return;

  sharedCache.set(url, { result, ts: Date.now() });
  if (sharedCache.size <= CACHE_MAX_ENTRIES) return;

  const now = Date.now();
  for (const [key, entry] of sharedCache) {
    if (now - entry.ts > CACHE_TTL_MS) sharedCache.delete(key);
  }
  // Toujours au-dessus du plafond : on retire les plus anciennes, l'ordre
  // d'insertion d'une Map étant celui de leur arrivée.
  let excess = sharedCache.size - CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  for (const key of sharedCache.keys()) {
    if (excess-- <= 0) break;
    sharedCache.delete(key);
  }
}
