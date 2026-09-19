import type { DudaParams } from '@websentry/shared';

/**
 * Lecture de `window.Parameters` — fonctions PURES.
 *
 * Duda sérialise sa configuration en JavaScript, pas en JSON : il n'existe pas
 * de parseur à lui opposer, seulement des expressions régulières. Elles vivent
 * TOUTES ici, pour que le rapport et le critère lisent exactement les mêmes
 * champs. La v1 les dispersait entre l'analyseur et l'enrichissement de gamme,
 * et les deux lectures avaient fini par diverger.
 */

/** Marqueur Duda d'un champ vide : la chaîne « null », pas la valeur nulle. */
const NULL_MARKER = 'null';
/** `e30=` est le base64 de `{}` — une boutique déclarée mais vide. */
const EMPTY_STORE_MARKER = 'e30=';

/** Échappe les métacaractères : la clé construit une expression régulière. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringParam(script: string, key: string): string | null {
  const match = new RegExp(`${escapeRegExp(key)}:\\s*['"]([^'"]*)['"]`).exec(script);
  return match?.[1] ?? null;
}

function boolParam(script: string, key: string): boolean | null {
  const match = new RegExp(`${escapeRegExp(key)}:\\s*(true|false)`).exec(script);
  return match ? match[1] === 'true' : null;
}

function numberParam(script: string, key: string): number | null {
  const match = new RegExp(`${escapeRegExp(key)}:\\s*(\\d+)`).exec(script);
  return match?.[1] ? Number(match[1]) : null;
}

/** Certains champs sont encodés en base64 dans le script — `SiteType` notamment. */
function atobParam(script: string, key: string): string | null {
  const match = new RegExp(`${escapeRegExp(key)}:\\s*atob\\(['"]([^'"]+)['"]\\)`).exec(script);
  if (!match?.[1]) return null;
  try {
    return Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/** Ramène à `null` les valeurs que Duda écrit comme des chaînes vides ou « null ». */
function real(value: string | null): string | null {
  return value && value !== NULL_MARKER ? value : null;
}

/**
 * Extrait les paramètres Duda d'un document, ou `null` si la page n'en a pas.
 *
 * `null` veut bien dire « pas un site Duda » — ce qui est le cas de la majorité
 * des pages analysées, et n'est pas une anomalie.
 */
export function parseDudaParameters(html: string): DudaParams | null {
  if (!html.includes('window.Parameters')) return null;

  const externalUid = stringParam(html, 'ExternalUid');
  const [rawGamme = '', rawEpj = ''] = (externalUid ?? '').split('|');

  return {
    homeUrl: stringParam(html, 'HomeUrl'),
    accountUUID: stringParam(html, 'AccountUUID'),
    systemID: stringParam(html, 'SystemID'),
    siteAlias: stringParam(html, 'SiteAlias'),
    siteType: atobParam(html, 'SiteType') ?? stringParam(html, 'SiteType'),
    publicationDate: stringParam(html, 'PublicationDate'),
    planID: stringParam(html, 'planID'),
    productId: stringParam(html, 'productId'),
    defaultLang: stringParam(html, 'defaultLang'),
    isMultilingual: boolParam(html, 'IsSiteMultilingual'),
    gamme: rawGamme.trim() || null,
    epj: rawEpj.trim() || null,
    externalUid,
    storePageAlias: stringParam(html, 'StorePageAlias'),
    storePagesUrls: stringParam(html, 'StorePagesUrls'),
    isNewStore: boolParam(html, 'IsNewStore'),
    storePath: stringParam(html, 'StorePath'),
    storeId: stringParam(html, 'StoreId'),
    storeVersion: numberParam(html, 'StoreVersion'),
    storeBaseUrl: stringParam(html, 'StoreBaseUrl'),
  };
}

/**
 * La boutique est-elle RÉELLEMENT active ?
 *
 * Duda renseigne les champs e-commerce même sans boutique, avec la chaîne
 * « null » et un catalogue base64 vide. Se fier à leur seule présence
 * annoncerait une boutique sur tout site Duda — d'où la conjonction, reprise
 * de la v1, de quatre champs réels ET d'un catalogue non vide.
 */
export function isEcommerceActive(params: DudaParams): boolean {
  return (
    Boolean(real(params.storePageAlias)) &&
    Boolean(real(params.storePath)) &&
    Boolean(real(params.storeId)) &&
    Boolean(real(params.storeBaseUrl)) &&
    hasStorePages(params.storePagesUrls)
  );
}

function hasStorePages(storePagesUrls: string | null): boolean {
  if (!storePagesUrls || storePagesUrls === EMPTY_STORE_MARKER) return false;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(storePagesUrls, 'base64').toString('utf-8'));
    return typeof decoded === 'object' && decoded !== null && Object.keys(decoded).length > 0;
  } catch {
    // Un catalogue illisible n'est pas un catalogue : annoncer une boutique sur
    // cette base ferait passer un site vitrine pour une boutique.
    return false;
  }
}

export { real as realValue };
