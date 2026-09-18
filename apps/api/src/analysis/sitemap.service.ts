import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { SitemapEntry, SitemapParseResponse } from '@websentry/shared';
import { MAX_RESPONSE_BYTES, SsrfService } from '../security/ssrf.service.js';
import { AppConfigService } from '../config/app-config.service.js';

/** Emplacements conventionnels d'un sitemap, dans l'ordre d'essai. */
const CONVENTIONAL_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

/**
 * Profondeur d'index suivie.
 *
 * Un sitemap d'index référence d'autres sitemaps, qui peuvent à leur tour en
 * référencer. Sans borne, un index qui se référence lui-même — accident
 * fréquent — ferait boucler la découverte indéfiniment.
 */
const MAX_INDEX_DEPTH = 2;

/** Sitemaps enfants explorés par index — borne le nombre de requêtes sortantes. */
const MAX_CHILD_SITEMAPS = 10;

/**
 * Découverte et lecture de sitemaps.
 *
 * Chaque requête passe par la politique SSRF, y compris celles déduites d'un
 * index : un sitemap est un document CONTRÔLÉ PAR LE SITE ANALYSÉ, donc une
 * liste d'URL fournie par un tiers. La traiter comme fiable reviendrait à
 * offrir une redirection SSRF à qui contrôle un sitemap.
 */
@Injectable()
export class SitemapService {
  private readonly logger = new Logger(SitemapService.name);

  constructor(
    private readonly ssrf: SsrfService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Cherche le sitemap d'un site : `robots.txt` d'abord, emplacements
   * conventionnels ensuite.
   *
   * `robots.txt` fait foi quand il déclare un `Sitemap:` — c'est la source que
   * le site publie lui-même, et deviner à sa place produirait un résultat
   * différent de ce que voit un moteur.
   */
  async detect(siteUrl: string): Promise<string | null> {
    const origin = originOf(siteUrl);
    if (!origin) return null;

    const declared = await this.fromRobots(origin);
    if (declared) return declared;

    for (const path of CONVENTIONAL_PATHS) {
      const candidate = `${origin}${path}`;
      if (await this.exists(candidate)) return candidate;
    }
    return null;
  }

  /** Lit un sitemap et en extrait les URL, index suivis. */
  async parse(
    sitemapUrl: string,
    options: { limit: number; filterByPriority: boolean },
  ): Promise<SitemapParseResponse> {
    const collected = await this.collect(sitemapUrl, 0);

    const filtered = options.filterByPriority
      ? collected.filter(entry => entry.priority !== null)
      : collected;

    const entries = filtered.slice(0, options.limit);
    return {
      sitemapUrl,
      // Le total DÉCOUVERT, avant troncature : sans lui, l'utilisateur croit
      // que son sitemap ne contient que `limit` URL.
      discovered: filtered.length,
      entries,
      truncated: filtered.length > entries.length,
    };
  }

  private async collect(sitemapUrl: string, depth: number): Promise<SitemapEntry[]> {
    const xml = await this.fetchText(sitemapUrl);
    if (!xml) return [];

    const $ = cheerio.load(xml, { xml: true });

    const childUrls = $('sitemapindex > sitemap > loc')
      .map((_, element) => $(element).text().trim())
      .get()
      .filter(Boolean);

    if (childUrls.length > 0) {
      if (depth >= MAX_INDEX_DEPTH) {
        this.logger.warn(`Profondeur d'index atteinte sur ${sitemapUrl} — exploration arrêtée`);
        return [];
      }
      const children = await Promise.all(
        childUrls.slice(0, MAX_CHILD_SITEMAPS).map(childUrl => this.collect(childUrl, depth + 1)),
      );
      return children.flat();
    }

    return $('urlset > url')
      .map((_, element): SitemapEntry => {
        const node = $(element);
        const priority = Number.parseFloat(node.find('priority').first().text().trim());
        return {
          url: node.find('loc').first().text().trim(),
          lastmod: node.find('lastmod').first().text().trim() || null,
          priority: Number.isFinite(priority) ? priority : null,
        };
      })
      .get()
      .filter(entry => entry.url.length > 0);
  }

  /** Première déclaration `Sitemap:` d'un `robots.txt`. */
  private async fromRobots(origin: string): Promise<string | null> {
    const body = await this.fetchText(`${origin}/robots.txt`);
    if (!body) return null;

    const match = /^\s*sitemap\s*:\s*(\S+)\s*$/im.exec(body);
    return match?.[1] ?? null;
  }

  private async exists(url: string): Promise<boolean> {
    try {
      const result = await this.ssrf.safeFetch(url, {
        method: 'HEAD',
        timeoutMs: this.config.fetchTimeoutMs,
      });
      try {
        return result.response.status >= 200 && result.response.status < 300;
      } finally {
        result.dispose();
      }
    } catch {
      return false;
    }
  }

  /**
   * Récupère un document texte, ou `null`.
   *
   * L'absence d'un sitemap est un cas NOMINAL — beaucoup de sites n'en ont
   * pas —, pas une erreur à propager : la faire remonter transformerait une
   * découverte infructueuse en échec de l'analyse.
   */
  private async fetchText(url: string): Promise<string | null> {
    try {
      const result = await this.ssrf.safeFetch(url, {
        method: 'GET',
        timeoutMs: this.config.fetchTimeoutMs,
      });
      try {
        if (result.response.status !== 200) return null;
        return await this.ssrf.readTextCapped(result.response, MAX_RESPONSE_BYTES);
      } finally {
        result.dispose();
      }
    } catch (err) {
      this.logger.debug(
        `Lecture impossible de ${url} : ${err instanceof Error ? err.message : 'cause inconnue'}`,
      );
      return null;
    }
  }
}

/** Origine (`protocole://hôte`) d'une URL, ou `null` si elle est illisible. */
export function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}
