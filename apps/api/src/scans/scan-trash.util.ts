/**
 * Sérialisation d'un instantané de corbeille — fonctions PURES.
 *
 * Deux pièges, tous deux constatés contre une vraie base.
 *
 * Le premier : un `JSON.stringify` naïf perd les binaires. Le rapport compressé
 * d'une page est un `Buffer`, et il ressortirait en `{ type: 'Buffer', data:
 * [ … ] }`, c'est-à-dire en objet que la restauration réinsérerait tel quel. La
 * page restaurée aurait un rapport illisible, sans que rien ne le signale.
 *
 * Le second : `mysql2` DÉSÉRIALISE les colonnes JSON. `metadata` revient en
 * objet JavaScript, et un objet passé en paramètre est échappé par le pilote en
 * paires « clé = valeur » — pas en JSON. La contrainte `json_valid` de MariaDB
 * refuse alors l'insertion. `decoderLigne` rend donc les objets à leur forme
 * textuelle : son rôle est de préparer la RÉINSERTION, pas seulement de relire.
 */

/** Marqueur d'une valeur binaire dans l'instantané. */
const CLE_BINAIRE = '$b64';

/** Une ligne de base, telle que l'instantané la transporte. */
export type LigneInstantanee = Record<string, unknown>;

function estBinaireEncode(valeur: unknown): valeur is Record<typeof CLE_BINAIRE, string> {
  return (
    typeof valeur === 'object' &&
    valeur !== null &&
    CLE_BINAIRE in valeur &&
    typeof (valeur as Record<string, unknown>)[CLE_BINAIRE] === 'string'
  );
}

/** Rend une ligne sérialisable en JSON, binaires compris. */
export function encoderLigne(ligne: LigneInstantanee): LigneInstantanee {
  const sortie: LigneInstantanee = {};
  for (const [cle, valeur] of Object.entries(ligne)) {
    sortie[cle] = Buffer.isBuffer(valeur) ? { [CLE_BINAIRE]: valeur.toString('base64') } : valeur;
  }
  return sortie;
}

/** Reconstitue une ligne d'instantané sous une forme RÉINSÉRABLE. */
export function decoderLigne(ligne: LigneInstantanee): LigneInstantanee {
  const sortie: LigneInstantanee = {};
  for (const [cle, valeur] of Object.entries(ligne)) {
    if (estBinaireEncode(valeur)) {
      sortie[cle] = Buffer.from(valeur[CLE_BINAIRE], 'base64');
      continue;
    }
    // Un objet ou un tableau vient forcément d'une colonne JSON : le pilote les
    // rend désérialisés, et il faut les lui rendre en texte.
    sortie[cle] = typeof valeur === 'object' && valeur !== null ? JSON.stringify(valeur) : valeur;
  }
  return sortie;
}

/**
 * Identité lisible d'une entrée de corbeille.
 *
 * Distincte de `siteIdentityKey` : celle-ci s'adresse à un humain qui relit sa
 * corbeille, pas à un index. Un domaine entier n'a pas de gamme, et écrire
 * « exemple.fr| » laisserait croire à une gamme vide.
 */
export function libelleCorbeille(
  scope: 'session' | 'site' | 'domain',
  domain: string,
  gamme: string | null,
): string {
  if (scope === 'domain') return domain;
  return gamme === null ? `${domain} (sans gamme)` : `${domain} — ${gamme}`;
}
