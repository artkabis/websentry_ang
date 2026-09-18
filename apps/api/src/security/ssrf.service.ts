import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch, type Response as UndiciResponse } from 'undici';
import { AppConfigService } from '../config/app-config.service.js';
import { isBlockedIp, stripBrackets } from './ip-rules.js';

/**
 * Garde SSRF : toute sortie HTTP du serveur passe par ici.
 *
 * Trois défenses cumulées, reprises intégralement de la v1 :
 *   1. Protocoles restreints à http/https.
 *   2. Résolution DNS MULTI-ENREGISTREMENT — si UNE SEULE adresse retournée est
 *      privée, l'URL est rejetée (interdit le contournement par un domaine
 *      résolvant à la fois vers une IP publique et vers 127.0.0.1).
 *   3. ÉPINGLAGE de la connexion sur les IP validées — undici ne re-résout pas,
 *      ce qui ferme la fenêtre de DNS rebinding entre la validation et le connect.
 *
 * Les redirections sont suivies MANUELLEMENT : chaque saut est re-validé, sinon
 * un 302 vers `http://169.254.169.254/` contournerait tout le dispositif.
 */

/** Adresse résolue, dans la forme attendue par le `lookup` d'undici. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * Liste d'adresses garantie NON VIDE.
 *
 * `resolvePublicAddresses` refuse déjà une résolution vide ; exprimer cette
 * garantie dans le type évite une garde d'exécution qui ne pourrait jamais se
 * déclencher — donc du code mort, impossible à tester honnêtement.
 */
export type NonEmptyAddresses = [ResolvedAddress, ...ResolvedAddress[]];

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  response: UndiciResponse;
  finalUrl: string;
  redirectChain: Array<{ url: string; status: number }>;
  redirected: boolean;
  /** Libère le corps non lu pour rendre la connexion au pool keep-alive. */
  dispose: () => void;
}

/** Erreur de politique SSRF — distincte d'une panne réseau, pour le mapping HTTP. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

interface ValidatedTarget {
  parsed: URL;
  /** Adresses publiques validées, ou null si l'hôte est une IP littérale déjà vérifiée. */
  pinnedAddresses: NonEmptyAddresses | null;
}

/** TTL du cache de résolutions validées — court, pour rester proche du DNS réel. */
const DNS_CACHE_TTL_MS = 10_000;
/** Nombre maximal de sauts de redirection suivis. */
const MAX_REDIRECTS = 10;
/** Fenêtre keep-alive d'une connexion inactive (ms). */
const AGENT_KEEP_ALIVE_MS = 10_000;
/** Durée de vie d'un agent épinglé en cache (ms). */
const AGENT_CACHE_TTL_MS = 30_000;
/** Borne du nombre d'agents en cache (limite sockets / mémoire). */
const MAX_CACHED_AGENTS = 256;
/** Taille maximale acceptée pour un corps de réponse (anti-DoS mémoire). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const DEFAULT_ACCEPT_LANGUAGE = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';

@Injectable()
export class SsrfService {
  private readonly logger = new Logger(SsrfService.name);

  private readonly dnsCache = new Map<string, { addresses: NonEmptyAddresses; ts: number }>();
  private readonly agentCache = new Map<string, { agent: Agent; ts: number }>();

  constructor(private readonly config: AppConfigService) {}

  /**
   * Vérifie qu'une URL est sûre à contacter, sans l'appeler.
   *
   * Signature `void` pour les appelants qui n'ont pas besoin d'épingler
   * (webhooks d'alerte, validation d'entrée utilisateur).
   */
  async assertPublicUrl(rawUrl: string): Promise<void> {
    await this.resolveValidatedTarget(rawUrl);
  }

  /**
   * Fetch SSRF-safe : validation par saut, redirections suivies manuellement,
   * connexion épinglée aux IP validées.
   *
   * Le corps n'est pas consommé — l'appelant le lit puis appelle `dispose()`.
   */
  async safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const {
      method = 'GET',
      headers = {},
      timeoutMs = this.config.fetchTimeoutMs,
      maxRedirects = MAX_REDIRECTS,
    } = opts;

    const redirectChain: Array<{ url: string; status: number }> = [];
    let currentUrl = url;
    let lastRes: UndiciResponse | null = null;

    const makeDispose = (res: UndiciResponse) => () => {
      void res.body?.cancel().catch(() => undefined);
    };

    for (let attempt = 0; attempt <= maxRedirects; attempt++) {
      const target = await this.resolveValidatedTarget(currentUrl);

      // Pas d'agent épinglé pour une IP littérale : il n'y a rien à re-résoudre.
      const agent = target.pinnedAddresses
        ? this.getPinnedAgent(stripBrackets(target.parsed.hostname), target.pinnedAddresses)
        : null;

      const res: UndiciResponse = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': this.config.fetchUserAgent,
          Accept: DEFAULT_ACCEPT,
          'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
        ...(agent ? { dispatcher: agent } : {}),
      });
      lastRes = res;

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          // Redirection sans `Location` : on rend la réponse telle quelle.
          return {
            response: res,
            finalUrl: currentUrl,
            redirectChain,
            redirected: redirectChain.length > 0,
            dispose: makeDispose(res),
          };
        }
        redirectChain.push({ url: currentUrl, status: res.status });
        try {
          await res.body?.cancel();
        } catch {
          /* corps déjà fermé */
        }
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      return {
        response: res,
        finalUrl: currentUrl,
        redirectChain,
        redirected: redirectChain.length > 0,
        dispose: makeDispose(res),
      };
    }

    try {
      await lastRes?.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new SsrfBlockedError(`Trop de redirections pour l'URL : ${url}`);
  }

  /**
   * Lit un corps de réponse en respectant un plafond d'octets.
   *
   * `Content-Length` est vérifié d'abord, mais il est facultatif et falsifiable :
   * la lecture se fait donc EN FLUX, en cumulant la taille, et s'interrompt dès le
   * plafond franchi — jamais de bufferisation intégrale avant contrôle.
   */
  async readTextCapped(res: UndiciResponse, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new SsrfBlockedError(
        `Réponse trop volumineuse (Content-Length: ${contentLength} octets, max ${maxBytes}).`,
      );
    }

    const body = res.body;
    if (!body) return '';

    const decoder = new TextDecoder('utf-8');
    // Annotation explicite : le typage d'undici rend `value` implicitement `any`,
    // qui se propagerait ensuite dans tout le calcul de taille.
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let total = 0;
    let text = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new SsrfBlockedError(`Réponse trop volumineuse (plafond ${maxBytes} octets).`);
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
      void body.cancel().catch(() => undefined);
    }

    return text + decoder.decode();
  }

  /** Vide les caches DNS et agents (arrêt propre, isolation entre tests). */
  reset(): void {
    for (const { agent } of this.agentCache.values()) {
      void agent.destroy().catch(() => undefined);
    }
    this.agentCache.clear();
    this.dnsCache.clear();
  }

  // ── Interne ───────────────────────────────────────────────────────────────

  /** Valide protocole + hôte et retourne les IP publiques sur lesquelles épingler. */
  private async resolveValidatedTarget(rawUrl: string): Promise<ValidatedTarget> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SsrfBlockedError('URL invalide');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlockedError('Seuls les protocoles http et https sont autorisés.');
    }

    const bareHostname = stripBrackets(parsed.hostname);

    // IP littérale : contrôle direct, ni résolution ni épinglage nécessaires.
    if (isIP(bareHostname)) {
      if (isBlockedIp(bareHostname)) {
        throw new SsrfBlockedError('Accès aux adresses IP privées non autorisé.');
      }
      return { parsed, pinnedAddresses: null };
    }

    const pinnedAddresses = await this.resolvePublicAddresses(bareHostname);
    return { parsed, pinnedAddresses };
  }

  /**
   * Résout un hostname et exige que TOUTES les adresses retournées soient publiques.
   * Lève dès la première adresse privée — politique la plus conservatrice.
   */
  private async resolvePublicAddresses(bareHostname: string): Promise<NonEmptyAddresses> {
    const now = Date.now();
    const cached = this.dnsCache.get(bareHostname);
    if (cached && now - cached.ts < DNS_CACHE_TTL_MS) {
      return cached.addresses;
    }

    let resolved: ResolvedAddress[];
    try {
      const all = await lookup(bareHostname, { all: true });
      resolved = all.map(a => ({ address: a.address, family: a.family }));
    } catch {
      throw new SsrfBlockedError(`Impossible de résoudre le nom d'hôte : ${bareHostname}`);
    }

    const [head, ...tail] = resolved;
    if (!head) {
      throw new SsrfBlockedError(`Impossible de résoudre le nom d'hôte : ${bareHostname}`);
    }
    // À partir d'ici, le type porte la garantie « au moins une adresse ».
    const validated: NonEmptyAddresses = [head, ...tail];

    for (const { address } of validated) {
      if (isBlockedIp(address)) {
        this.logger.warn(`SSRF bloqué — ${bareHostname} résout vers une adresse privée`);
        throw new SsrfBlockedError('Accès aux adresses IP privées non autorisé.');
      }
    }

    this.dnsCache.set(bareHostname, { addresses: validated, ts: Date.now() });
    return validated;
  }

  /** Clé de cache : hôte + liste d'IP validées triée (réutilisation stricte). */
  private agentKey(hostname: string, addresses: NonEmptyAddresses): string {
    return `${hostname}|${addresses
      .map(a => a.address)
      .sort()
      .join(',')}`;
  }

  /**
   * Agent undici keep-alive dont la résolution est court-circuitée par un `lookup`
   * ne renvoyant que les IP déjà validées — c'est là que l'anti-rebinding se joue.
   */
  private createPinnedAgent(addresses: NonEmptyAddresses): Agent {
    const [first] = addresses;
    return new Agent({
      keepAliveTimeout: AGENT_KEEP_ALIVE_MS,
      keepAliveMaxTimeout: AGENT_CACHE_TTL_MS,
      connections: 8,
      connect: {
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | ResolvedAddress[],
            family?: number,
          ) => void,
        ) => {
          if (options?.all) {
            callback(null, addresses);
          } else {
            callback(null, first.address, first.family);
          }
        },
      },
    });
  }

  /** Récupère (ou crée) l'agent épinglé pour un hôte et son jeu d'IP validées. */
  private getPinnedAgent(hostname: string, addresses: NonEmptyAddresses): Agent {
    const now = Date.now();
    const key = this.agentKey(hostname, addresses);

    const cached = this.agentCache.get(key);
    if (cached && now - cached.ts < AGENT_CACHE_TTL_MS) {
      return cached.agent;
    }
    if (cached) {
      void cached.agent.destroy().catch(() => undefined);
      this.agentCache.delete(key);
    }

    // Éviction du plus ancien quand le pool est plein. Sans borne, un scan
    // touchant des milliers d'hôtes ferait croître le pool de sockets sans fin.
    //
    // Une `Map` itère dans l'ordre d'INSERTION, et l'horodatage croît avec elle :
    // la première entrée est donc la plus ancienne. Inutile de trier ou de
    // comparer — la boucle s'arrête dès qu'elle a évincé une entrée.
    if (this.agentCache.size >= MAX_CACHED_AGENTS) {
      for (const [oldestKey, stale] of this.agentCache) {
        void stale.agent.destroy().catch(() => undefined);
        this.agentCache.delete(oldestKey);
        break;
      }
    }

    const agent = this.createPinnedAgent(addresses);
    this.agentCache.set(key, { agent, ts: now });
    return agent;
  }
}
