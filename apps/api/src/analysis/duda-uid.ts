import { DEFAULT_PROFILE, normalizeGamme } from '@websentry/shared';

/**
 * Lecture de l'`ExternalUid` Duda — fonctions PURES.
 *
 * Le champ vit dans `window.Parameters`, du JavaScript et non du JSON : il n'y
 * a pas de parseur à lui opposer, seulement une expression régulière. Elle est
 * volontairement ÉTROITE — un seul motif, une seule source de vérité. La v1 en
 * avait trois copies légèrement divergentes, dont une sans `trim()`, si bien
 * que la même page pouvait être rattachée à deux gammes selon le chemin de code
 * emprunté.
 */
const EXTERNAL_UID_PATTERN = /ExternalUid\s*:\s*['"]([^'"]{1,200})['"]/;

/** Valeur Duda signifiant « non renseigné ». */
const EMPTY_MARKER = '—';

export interface ParsedExternalUid {
  /** Gamme normalisée, ou `null` quand la page n'en déclare aucune. */
  gamme: string | null;
  epj: string | null;
}

export function parseExternalUid(html: string): ParsedExternalUid {
  const match = EXTERNAL_UID_PATTERN.exec(html);
  if (!match?.[1]) return { gamme: null, epj: null };

  const [rawGamme = '', rawEpj = ''] = match[1].split('|');
  const gamme = normalizeGamme(rawGamme.trim());
  const epj = rawEpj.trim();

  return {
    // `default` n'est pas une gamme mais le nom du profil de repli : le rendre
    // ici ferait croire à une détection réussie, et masquerait le fait que la
    // page ne déclare rien.
    gamme: gamme && gamme !== EMPTY_MARKER && gamme !== DEFAULT_PROFILE ? gamme : null,
    epj: epj && epj !== EMPTY_MARKER ? epj : null,
  };
}

/** Gamme détectée dans une page, ou `null`. */
export function extractGamme(html: string): string | null {
  return parseExternalUid(html).gamme;
}

/** EPJ détecté dans une page, ou `null`. */
export function extractEpj(html: string): string | null {
  return parseExternalUid(html).epj;
}
