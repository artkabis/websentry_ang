import { isIP } from 'node:net';

/**
 * Détection des adresses non routables / privées / réservées (anti-SSRF).
 *
 * Logique framework-agnostique portée telle quelle depuis la v1
 * (`apps/api/src/dom/static-fetcher.ts`) : la politique de blocage est identique,
 * seul son emballage change (provider Nest au lieu d'un module libre).
 */

/** Plages IPv4 privées / réservées, en notation pointée-décimale. */
const PRIVATE_V4: readonly RegExp[] = [
  /^127\./, // loopback
  /^0\./, // « this network » (0.0.0.0/8)
  /^10\./, // RFC 1918 classe A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 classe B
  /^192\.168\./, // RFC 1918 classe C
  /^169\.254\./, // link-local (métadonnées cloud : 169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT RFC 6598
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1
  /^198\.1[89]\./, // benchmarking 198.18.0.0/15
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^22[4-9]\./, // multicast / réservé 224.0.0.0/3
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

/** Plages IPv6 privées / réservées (forme texte normalisée en minuscules). */
const PRIVATE_V6_LITERAL: readonly RegExp[] = [
  /^::$/, // non spécifié
  /^::1$/, // loopback
  /^fe80:/, // link-local
  /^fc[0-9a-f]{2}:/, // ULA
  /^fd[0-9a-f]{2}:/, // ULA
  /^ff[0-9a-f]{2}:/, // multicast
];

/** Convertit la partie hexadécimale d'un IPv6 mappé IPv4 (`7f00:1`) en pointé-décimal. */
function hexPairsToV4(hex: string): string | null {
  const parts = hex.split(':');
  if (parts.length !== 2) return null;
  const [hiRaw, loRaw] = parts as [string, string];
  const hi = parseInt(hiRaw.padStart(4, '0'), 16);
  const lo = parseInt(loRaw.padStart(4, '0'), 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateV4(v4: string): boolean {
  return PRIVATE_V4.some(re => re.test(v4));
}

/**
 * Indique si une IP (littérale ou résolue) est privée / non routable / réservée.
 *
 * Gère IPv4, IPv6, IPv4-mapped IPv6 (`::ffff:127.0.0.1` et `::ffff:7f00:1`) et
 * NAT64 (`64:ff9b::/96`). Toute forme non reconnue est REFUSÉE par défaut :
 * en cas de doute sur ce qu'une pile réseau fera d'une chaîne, on ne sort pas.
 */
export function isBlockedIp(ip: string): boolean {
  const lower = ip.toLowerCase().trim();

  // IPv4 direct
  if (isIP(lower) === 4) {
    return isPrivateV4(lower);
  }

  // IPv4-mapped IPv6 : ::ffff:a.b.c.d ou ::ffff:7f00:1
  const mapped = /^::ffff:(.+)$/.exec(lower);
  if (mapped?.[1]) {
    const inner = mapped[1];
    if (inner.includes('.')) return isPrivateV4(inner);
    const v4 = hexPairsToV4(inner);
    if (v4) return isPrivateV4(v4);
  }

  // NAT64 (64:ff9b::/96) : les 32 bits de poids faible portent l'IPv4 cible.
  const nat64 = /^64:ff9b::(.+)$/.exec(lower);
  if (nat64?.[1]) {
    const inner = nat64[1];
    if (inner.includes('.')) return isPrivateV4(inner);
    const v4 = hexPairsToV4(inner);
    if (v4) return isPrivateV4(v4);
    // Forme inconnue derrière le préfixe NAT64 : blocage par prudence.
    return true;
  }

  // IPv6 littéral
  if (isIP(lower) === 6) {
    return PRIVATE_V6_LITERAL.some(re => re.test(lower));
  }

  // Forme non reconnue : refus par défaut.
  return true;
}

/** Normalise un hostname IPv6 entre crochets pour `isIP()`. */
export function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
