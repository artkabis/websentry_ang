import type { SafeFetchResult, SsrfService } from '../security/ssrf.service.js';
import { SsrfBlockedError } from '../security/ssrf.service.js';
import type { ProbeResult } from './network-probe.js';

/**
 * Moteur de sortie réseau — la seule chose du projet qui émette une requête
 * pour le compte d'un analyseur.
 *
 * Il ne connaît NI budget NI critère : il sait joindre une URL, se souvenir de
 * ce qu'il a vu, et ne jamais faire deux fois le même travail. Le partage des
 * requêtes entre critères est décidé une couche au-dessus (`network-probe.ts`),
 * sur des quotas fixes — ici, tout ce qui compte est de ne pas sortir deux fois
 * pour la même adresse.
 *
 * Trois déduplications se cumulent, et c'est voulu : le menu et le pied de page
 * d'un site sont présents sur TOUTES ses pages, et un scan de sitemap les
 * revérifierait autant de fois qu'il y a de pages.
 *   1. Cache par URL, partagé par le processus.
 *   2. Requêtes EN VOL : deux demandes simultanées sur la même URL partagent la
 *      même requête au lieu d'en émettre deux.
 *   3. Portail de concurrence global : le site audité voit un nombre borné de
 *      connexions, quel que soit le nombre de critères qui travaillent.
 */

/** Résultat accompagné de ce qu'il a coûté : une requête réelle, ou rien. */
export interface BilledResult {
  result: ProbeResult;
  /** Faux quand la réponse vient du cache ou d'une requête déjà en vol. */
  billable: boolean;
}

export interface BilledText extends BilledResult {
  body: string | null;
}

export interface ProbeEngine {
  resolve(url: string): Promise<BilledResult>;
  text(url: string, maxBytes: number): Promise<BilledText>;
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

/** Requêtes simultanées vers l'extérieur — au-delà, on martèle le site audité. */
export const DEFAULT_CONCURRENCY = 5;
/** Durée de validité d'un résultat obtenu. */
const SUCCESS_TTL_MS = 10 * 60 * 1000;
/**
 * Durée de validité d'un ÉCHEC — beaucoup plus courte.
 *
 * Un hôte qui a dépassé le délai une fois n'est pas mort pour dix minutes. Lui
 * appliquer le TTL des succès le déclarerait injoignable sur toutes les pages
 * d'un lot, pour un incident d'une seconde.
 */
const FAILURE_TTL_MS = 60 * 1000;
/** Bornes du cache, pour un processus qui vit longtemps. */
const CACHE_MAX_ENTRIES = 5000;
/** Corps mémorisés : peu nombreux, car bien plus lourds qu'un statut. */
const TEXT_CACHE_MAX_ENTRIES = 32;
/** Au-delà, un corps n'est pas mémorisé — le cache n'est pas un entrepôt. */
const TEXT_CACHE_MAX_BYTES = 256 * 1024;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Caches PARTAGÉS par le processus : une même URL n'est vue qu'une fois. */
const resultCache = new Map<string, CacheEntry<ProbeResult>>();
const textCache = new Map<string, CacheEntry<{ result: ProbeResult; body: string | null }>>();
const inFlightResults = new Map<string, Promise<ProbeResult>>();
const inFlightTexts = new Map<string, Promise<{ result: ProbeResult; body: string | null }>>();

/** Vide les caches de sonde — réservé aux tests et aux purges explicites. */
export function clearProbeCache(): void {
  resultCache.clear();
  textCache.clear();
  inFlightResults.clear();
  inFlightTexts.clear();
}

export interface ProbeEngineOptions {
  timeoutMs?: number;
  concurrency?: number;
}

export class SsrfProbeEngine implements ProbeEngine {
  private readonly timeoutMs: number;
  private readonly gate: Gate;

  constructor(
    private readonly ssrf: Pick<SsrfService, 'safeFetch' | 'readTextCapped'>,
    options: ProbeEngineOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.gate = new Gate(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY));
  }

  async resolve(url: string): Promise<BilledResult> {
    const cached = cacheGet(resultCache, url);
    if (cached) return { result: cached, billable: false };

    // Une requête déjà partie sur cette URL : on attend SA réponse plutôt que
    // d'en émettre une seconde. Sans cela, dix images identiques lancées de
    // front produiraient dix requêtes, le cache n'étant écrit qu'au retour.
    const pending = inFlightResults.get(url);
    if (pending) return { result: await pending, billable: false };

    const request = this.gate.run(() => this.perform(url));
    inFlightResults.set(url, request);
    try {
      const result = await request;
      cacheSet(resultCache, url, result, ttlFor(result), CACHE_MAX_ENTRIES);
      return { result, billable: true };
    } finally {
      inFlightResults.delete(url);
    }
  }

  async text(url: string, maxBytes: number): Promise<BilledText> {
    // Le plafond entre dans la clé : deux appels qui ne lisent pas la même
    // quantité n'obtiennent pas le même corps.
    const key = `${maxBytes}|${url}`;
    const cached = cacheGet(textCache, key);
    if (cached) return { ...cached, billable: false };

    const pending = inFlightTexts.get(key);
    if (pending) return { ...(await pending), billable: false };

    const request = this.gate.run(() => this.performText(url, maxBytes));
    inFlightTexts.set(key, request);
    try {
      const fetched = await request;
      if (isCacheableBody(fetched.body)) {
        cacheSet(textCache, key, fetched, ttlFor(fetched.result), TEXT_CACHE_MAX_ENTRIES);
      }
      return { ...fetched, billable: true };
    } finally {
      inFlightTexts.delete(key);
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

  private async performText(
    url: string,
    maxBytes: number,
  ): Promise<{ result: ProbeResult; body: string | null }> {
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
}

/**
 * Portail de concurrence.
 *
 * Il borne les requêtes SIMULTANÉES du processus, et non celles d'un appel :
 * quatre critères réseau travaillant de front avec chacun leur pool
 * ouvriraient quatre fois plus de connexions que prévu sur le site audité.
 */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
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

function ttlFor(result: ProbeResult): number {
  return result.status === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
}

function isCacheableBody(body: string | null): boolean {
  return body !== null && Buffer.byteLength(body, 'utf8') <= TEXT_CACHE_MAX_BYTES;
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number,
): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size <= maxEntries) return;

  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(entryKey);
  }
  // Toujours au-dessus du plafond : on retire les plus anciennes, l'ordre
  // d'insertion d'une Map étant celui de leur arrivée.
  let excess = cache.size - maxEntries;
  for (const entryKey of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(entryKey);
  }
}
