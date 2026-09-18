import * as cheerio from 'cheerio';
import type { Platform } from '@websentry/shared';

/**
 * Détection de plateforme et de titre — fonctions PURES, sans réseau.
 *
 * Elles ne parsent que le PRÉFIXE du document. Les marqueurs cherchés vivent
 * dans le `<head>` ou à l'ouverture du `<body>` ; parser cent kilo-octets de
 * contenu pour lire un `<title>` bloquerait la boucle d'événements du thread
 * principal, qui n'a justement pas vocation à analyser quoi que ce soit.
 */

/** Octets de HTML examinés pour la détection — le `<head>` y tient très largement. */
export const DETECT_SCAN_BYTES = 64 * 1024;

/**
 * Marqueurs de plateforme cherchés sur le document ENTIER.
 *
 * Une simple recherche de sous-chaîne, sans parse : c'est peu coûteux même sur
 * un gros document, et ces marqueurs peuvent apparaître n'importe où (URL de
 * CDN dans un attribut, chemin de thème dans un script en fin de page).
 */
const DUDA_MARKERS = ['cdn-website.com'];
const WORDPRESS_MARKERS = ['/wp-content/', '/wp-includes/'];

function detectPlatform($: cheerio.CheerioAPI, html: string): Platform {
  if ($('#dmRoot').length > 0 || $('#dm').length > 0) return 'duda';
  if (DUDA_MARKERS.some(marker => html.includes(marker))) return 'duda';

  if ($('body').hasClass('wordpress')) return 'wordpress';
  if (WORDPRESS_MARKERS.some(marker => html.includes(marker))) return 'wordpress';

  return 'generic';
}

/**
 * Titre de la page.
 *
 * `<title>` d'abord, `og:title` en repli — c'est ce que font les moteurs, et
 * une page qui n'a que le second reste identifiable dans l'historique plutôt
 * que d'y apparaître sans nom.
 */
function detectTitle($: cheerio.CheerioAPI): string {
  const title = $('title').first().text().trim();
  if (title) return title;
  return ($('meta[property="og:title"]').attr('content') ?? '').trim();
}

export function detectPlatformAndTitle(html: string): { platform: Platform; title: string } {
  const prefix = html.length > DETECT_SCAN_BYTES ? html.slice(0, DETECT_SCAN_BYTES) : html;
  const $ = cheerio.load(prefix);
  return { platform: detectPlatform($, html), title: detectTitle($) };
}
