import type { CheerioAPI } from 'cheerio';
import type { Platform, RedirectHop } from '@websentry/shared';

/**
 * Page récupérée, telle que la voient les analyseurs.
 *
 * `$` est une instance Cheerio : elle n'est PAS sérialisable, donc jamais
 * transmise au worker. C'est la raison d'être de `SerializablePage` : le thread
 * principal récupère le HTML, le worker le re-parse chez lui. Le parse complet
 * d'un document de plusieurs centaines de kilo-octets est précisément le travail
 * qu'on veut sortir de la boucle d'événements.
 */
export interface HtmlPage extends SerializablePage {
  $: CheerioAPI;
}

/**
 * Sélection Cheerio, telle que `$(sélecteur)` la rend.
 *
 * L'alias évite d'importer `domhandler` — dépendance TRANSITIVE de cheerio —
 * dans chaque analyseur qui manipule un élément : en dépendre directement
 * sans le déclarer casserait à la première montée de version de cheerio.
 */
export type Selection = ReturnType<CheerioAPI>;

/**
 * Élément du document, réduit à ce que les analyseurs lisent.
 *
 * Même raison que pour `Selection` : dépendre directement de `domhandler`,
 * dépendance TRANSITIVE de cheerio, casserait à la première montée de version.
 * `parent` reste `unknown` parce qu'un parent peut être le document lui-même,
 * qui n'est pas un élément — le code qui remonte les ancêtres doit le vérifier.
 */
export interface DomElement {
  readonly name: string;
  readonly attribs: Record<string, string>;
  readonly parent: unknown;
}

/** Portion transférable d'une page — ce qui franchit la frontière du worker. */
export interface SerializablePage {
  /** URL FINALE, redirections suivies. */
  url: string;
  html: string;
  title: string;
  platform: Platform;
  headers: Record<string, string>;
  statusCode: number;
  /** Temps jusqu'au premier octet, en millisecondes. */
  ttfb: number;
  redirectChain: RedirectHop[];
}
