import * as z from 'zod';

/**
 * Supervision — schémas partagés API ⇄ frontend.
 *
 * Le module existe parce que trois pannes réelles ne se voyaient jusqu'ici que
 * dans les journaux du serveur : une base injoignable, un pool d'analyse mort
 * (qui fait silencieusement retomber l'analyse en ligne, donc lente), et un
 * passage de rétention en échec (qui laisse la table des rapports gonfler).
 *
 * Cette réponse est RÉSERVÉE aux comptes autorisés. La sonde publique
 * `/health` reste délibérément pauvre : une sonde bavarde est un outil de
 * reconnaissance offert gratuitement (OWASP #7).
 */

/**
 * Trois états, et pas davantage.
 *
 * `degrade` est celui qui compte : un composant qui fonctionne en repli — le
 * pool d'analyse tombé, remplacé par l'exécution en ligne — n'est ni sain ni
 * en panne, et le ranger dans l'une ou l'autre case ferait perdre l'
 * information qui justifie une intervention.
 */
export const EtatComposantSchema = z.enum(['ok', 'degrade', 'panne']);
export type EtatComposant = z.infer<typeof EtatComposantSchema>;

const Composant = z.object({
  etat: EtatComposantSchema,
  /** Une phrase, destinée à être lue telle quelle à l'écran. */
  message: z.string(),
});

export const BaseDeDonneesSchema = Composant.extend({
  active: z.boolean(),
  /** Latence d'un aller-retour minimal, `null` si la base est absente. */
  latenceMs: z.number().int().min(0).nullable(),
}).strict();

export const PoolAnalyseSchema = Composant.extend({
  /** Configuré pour utiliser des threads ? */
  active: z.boolean(),
  /** Le pool tourne-t-il réellement ? */
  demarre: z.boolean(),
  /**
   * Le pool a échoué et ne sera PAS réessayé : l'analyse retombe en ligne.
   * C'est le cas qui justifie `degrade` plutôt que `panne` — l'outil rend
   * toujours un rapport, simplement plus lentement.
   */
  enEchec: z.boolean(),
  threadsMax: z.number().int().min(0),
}).strict();

export const RetentionEtatSchema = Composant.extend({
  active: z.boolean(),
  /** Dernier passage observé depuis le démarrage — `null` si aucun encore. */
  dernierPassage: z
    .object({
      termineA: z.iso.datetime(),
      compresses: z.number().int().min(0),
      purges: z.number().int().min(0),
      restants: z.number().int().min(0),
      dureeMs: z.number().int().min(0),
      reussi: z.boolean(),
    })
    .nullable(),
}).strict();

/** Volumétrie — ce que l'instance porte réellement. */
export const VolumetrieSchema = z
  .object({
    scans24h: z.number().int().min(0),
    scans7j: z.number().int().min(0),
    comptesActifs: z.number().int().min(0),
    retoursOuverts: z.number().int().min(0),
  })
  .strict();

export const InstanceSchema = z
  .object({
    version: z.string(),
    environnement: z.string(),
    /** Secondes écoulées depuis le démarrage du processus. */
    uptimeSec: z.number().int().min(0),
  })
  .strict();

export const SupervisionSchema = z
  .object({
    /**
     * Verdict global, DÉRIVÉ des composants et jamais déclaré à part : deux
     * sources pourraient se contredire, et c'est alors le résumé qu'on croit.
     */
    etat: EtatComposantSchema,
    releveA: z.iso.datetime(),
    instance: InstanceSchema,
    base: BaseDeDonneesSchema,
    poolAnalyse: PoolAnalyseSchema,
    retention: RetentionEtatSchema,
    /** `null` quand la base est injoignable — on ne devine pas des chiffres. */
    volumetrie: VolumetrieSchema.nullable(),
  })
  .strict();

export type Supervision = z.infer<typeof SupervisionSchema>;
export type BaseDeDonnees = z.infer<typeof BaseDeDonneesSchema>;
export type PoolAnalyse = z.infer<typeof PoolAnalyseSchema>;
export type RetentionEtat = z.infer<typeof RetentionEtatSchema>;
export type Volumetrie = z.infer<typeof VolumetrieSchema>;

/** Rang d'un état : le pire l'emporte sur l'ensemble. */
const GRAVITE: Readonly<Record<EtatComposant, number>> = { ok: 0, degrade: 1, panne: 2 };

/**
 * Verdict global à partir des états observés.
 *
 * Le PIRE l'emporte : annoncer « tout va bien » parce que deux composants sur
 * trois fonctionnent est exactement ce qui fait ignorer un tableau de bord.
 */
export function etatGlobal(etats: readonly EtatComposant[]): EtatComposant {
  return etats.reduce<EtatComposant>(
    (pire, etat) => (GRAVITE[etat] > GRAVITE[pire] ? etat : pire),
    'ok',
  );
}
