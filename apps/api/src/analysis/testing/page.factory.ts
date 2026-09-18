import * as cheerio from 'cheerio';
import { defaultAnalysisSettings } from '@websentry/shared';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage, SerializablePage } from '../page.model.js';

/**
 * Fabrique de pages pour les tests d'analyseurs.
 *
 * Les analyseurs étant des fonctions pures d'une page vers un résultat, les
 * tester ne demande ni réseau ni base : un fragment de HTML suffit, et c'est ce
 * qui permet d'en couvrir les cas limites un par un.
 */
export function makePage(html: string, over: Partial<SerializablePage> = {}): HtmlPage {
  const document = html.trim().startsWith('<') ? html : `<html><body>${html}</body></html>`;
  const base: SerializablePage = {
    url: 'https://exemple.fr/',
    html: document,
    title: '',
    platform: 'generic',
    headers: {},
    statusCode: 200,
    ttfb: 100,
    redirectChain: [],
    ...over,
  };
  return { ...base, $: cheerio.load(base.html) };
}

/** Réglages par défaut, éventuellement surchargés — jamais partagés entre tests. */
export function makeSettings(over: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return { ...defaultAnalysisSettings(), ...over };
}
