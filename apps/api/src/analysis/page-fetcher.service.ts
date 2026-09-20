import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { AppConfigService } from '../config/app-config.service.js';
import { MAX_RESPONSE_BYTES, SsrfService } from '../security/ssrf.service.js';
import { detectPlatformAndTitle } from './page-detect.js';
import type { HtmlPage, SerializablePage } from './page.model.js';

/**
 * Récupération d'une page à analyser.
 *
 * **Tout** passe par `SsrfService.safeFetch` : résolution DNS multi-adresses,
 * refus des plages privées, épinglage de l'IP validée pour la connexion, et
 * re-validation à CHAQUE saut de redirection. C'est la seule porte de sortie du
 * processus, et l'analyse est la seule fonctionnalité qui l'emprunte — d'où le
 * soin mis à ne jamais la contourner, fût-ce pour « juste récupérer le HTML ».
 */
@Injectable()
export class PageFetcherService {
  private readonly logger = new Logger(PageFetcherService.name);

  constructor(
    private readonly ssrf: SsrfService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Récupère une page et en extrait le strict nécessaire.
   *
   * Le résultat est SÉRIALISABLE : aucune instance Cheerio, donc transférable
   * tel quel au worker d'analyse. Le thread principal ne parse que le préfixe,
   * pour la plateforme et le titre.
   */
  async fetchPage(url: string): Promise<SerializablePage> {
    const startedAt = Date.now();
    const result = await this.ssrf.safeFetch(url, {
      method: 'GET',
      timeoutMs: this.config.fetchTimeoutMs,
    });

    try {
      const response = result.response;
      // Mesuré à la réception des en-têtes, avant la lecture du corps : c'est
      // bien le temps jusqu'au premier octet, pas le temps de téléchargement.
      const ttfb = Date.now() - startedAt;

      const html = await this.ssrf.readTextCapped(response, MAX_RESPONSE_BYTES);
      const { platform, title } = detectPlatformAndTitle(html);

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });

      return {
        url: result.finalUrl,
        html,
        title,
        platform,
        headers,
        statusCode: response.status,
        ttfb,
        redirectChain: result.redirectChain,
      };
    } finally {
      // Libère le corps non lu : sans cela, la connexion reste retenue hors du
      // pool keep-alive, et un lot de deux cents pages les épuise.
      result.dispose();
    }
  }
}

/**
 * Reconstruit une page interrogeable à partir de sa forme sérialisée.
 *
 * Appelée DANS le worker : c'est là que le parse complet doit avoir lieu, sur
 * un thread qui n'a rien d'autre à faire.
 */
export function rehydratePage(data: SerializablePage): HtmlPage {
  return { ...data, $: cheerio.load(data.html) };
}
