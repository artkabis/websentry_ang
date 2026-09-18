import {
  CheckSummarySchema,
  ProfileSnapshotSchema,
  SiteMetadataSchema,
  type CheckSummary,
  type ProfileSnapshot,
  type ReportState,
  type SiteMetadata,
} from '@websentry/shared';

/**
 * Traduction des lignes SQL vers le contrat partagé — fonctions PURES.
 *
 * Elles portent tout ce que le driver ne garantit pas : un `DECIMAL` revient en
 * chaîne, une colonne `JSON` tantôt décodée tantôt non, un `DATETIME` en texte
 * sans fuseau. Les rassembler ici évite que chaque service redécouvre ces
 * conversions — et les teste sans base.
 */

/**
 * Convertit un `DECIMAL` MariaDB en nombre.
 *
 * Le driver rend les `DECIMAL` en CHAÎNE pour préserver la précision. Un
 * `Number(...)` direct suffirait, mais laisserait passer `NaN` sur une colonne
 * corrompue ; on rend alors `null`, qui est déjà une valeur prévue du contrat.
 */
export function toNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Score arrondi au dixième — l'échelle 0–5 ne porte pas plus de précision. */
export function toScore(raw: string | number | null | undefined): number | null {
  const value = toNumber(raw);
  if (value === null) return null;
  // Une valeur hors échelle vient forcément d'une donnée corrompue : la rendre
  // telle quelle ferait échouer la validation du contrat à la frontière HTTP,
  // donc perdre TOUTE la page pour une seule colonne.
  const bounded = Math.min(5, Math.max(0, value));
  return Math.round(bounded * 10) / 10;
}

export function toInt(raw: string | number | null | undefined): number | null {
  const value = toNumber(raw);
  return value === null ? null : Math.trunc(value);
}

/**
 * Convertit un `DATETIME` MariaDB en ISO 8601.
 *
 * Le pool est configuré en `dateStrings` : les colonnes reviennent sous la forme
 * `2026-06-04 10:00:00`, sans fuseau. Les laisser traverser `new Date(...)` sans
 * précision les ferait interpréter dans le fuseau du PROCESSUS — un serveur en
 * Europe/Paris décalerait alors tout l'historique de deux heures l'été. Le `Z`
 * explicite dit ce que la base stocke réellement : de l'UTC.
 */
export function toIso(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Horodatage d'analyse d'une ligne, en ISO.
 *
 * Les colonnes `analyzed_at` sont `NOT NULL` dans les trois tables : une valeur
 * illisible signale une donnée corrompue, pas un cas nominal. On retombe alors
 * sur l'époque Unix — une date de 1970 saute aux yeux dans l'interface — plutôt
 * que de faire échouer la lecture de TOUT l'historique pour une ligne.
 *
 * Cette fonction existe pour que ce repli soit décidé UNE fois : dispersé sur
 * chaque conversion, il finit par diverger, et personne ne sait plus quelle
 * lecture tolère quoi.
 */
export function toAnalyzedAt(raw: string | Date | null | undefined): string {
  return toIso(raw) ?? new Date(0).toISOString();
}

/** Décode une colonne `JSON`, que le driver l'ait déjà désérialisée ou non. */
export function decodeJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Résumé des critères, validé.
 *
 * Une ligne peut avoir été écrite par une version antérieure du référentiel, ou
 * modifiée à la main. Un résumé invalide ne doit pas faire échouer la lecture de
 * TOUTE la page — l'historique est consultable même dégradé — mais il ne doit
 * pas non plus être servi tel quel : on rend un résumé vide, que l'interface
 * affiche comme « aucun critère », plutôt qu'une forme inattendue.
 */
export function toCheckSummary(raw: unknown): CheckSummary {
  const result = CheckSummarySchema.safeParse(decodeJson(raw));
  return result.success ? result.data : {};
}

export function toSiteMetadata(raw: unknown): SiteMetadata | null {
  const decoded = decodeJson(raw);
  if (decoded == null) return null;
  const result = SiteMetadataSchema.safeParse(decoded);
  return result.success ? result.data : null;
}

export function toProfileSnapshot(raw: unknown): ProfileSnapshot | null {
  const decoded = decodeJson(raw);
  if (decoded == null) return null;
  const result = ProfileSnapshotSchema.safeParse(decoded);
  return result.success ? result.data : null;
}

/**
 * État du rapport d'une page.
 *
 * Trois cas, et la distinction compte : `purged` dit que la rétention a effacé
 * un rapport qui a existé, là où l'absence pure et simple dit qu'il n'y en a
 * jamais eu. La v1 confondait les deux et répondait 404 dans les deux cas.
 */
export function toReportState(row: {
  is_compressed: number;
  has_report?: number;
  report?: string | null;
  report_gz?: Buffer | string | null;
}): ReportState {
  const present =
    row.has_report != null
      ? Number(row.has_report) === 1
      : row.report != null || row.report_gz != null;

  if (!present) return 'purged';
  return Number(row.is_compressed) === 1 ? 'compressed' : 'inline';
}
