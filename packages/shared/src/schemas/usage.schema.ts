import * as z from 'zod';

/**
 * Analytics d'usage — schémas partagés API ⇄ frontend.
 *
 * Ce module ne COLLECTE RIEN. Il agrège ce que l'application enregistre déjà
 * pour d'autres raisons : le journal d'audit, qui existe pour la traçabilité,
 * et l'historique des scans, qui existe pour la preuve. Ajouter une collecte
 * dédiée aurait créé une seconde base de données personnelles là où la
 * première suffit — exactement ce que la minimisation interdit.
 *
 * Conséquence directe, et vérifiée par test : **aucune réponse de ce module ne
 * nomme une personne**. Les compteurs portent sur des comptes distincts, jamais
 * sur des identités. Qui a fait quoi se lit dans le journal d'audit, réservé au
 * rang 100 ; combien de comptes ont fait quoi se lit ici.
 */

/**
 * Fenêtre d'observation.
 *
 * Trois valeurs fermées plutôt qu'un intervalle libre : une plage arbitraire
 * laisserait isoler une journée, puis une heure — et un compteur sur une heure
 * dans une équipe de dix personnes ne compte plus des comptes, il désigne
 * quelqu'un.
 */
export const UsagePeriodSchema = z.enum(['7j', '30j', '90j']);
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;

/** Nombre de jours couverts par une fenêtre. */
export const JOURS_PAR_PERIODE: Readonly<Record<UsagePeriod, number>> = {
  '7j': 7,
  '30j': 30,
  '90j': 90,
};

/**
 * Seuil d'agrégation.
 *
 * En dessous, un compteur ne protège plus personne : « 1 compte a supprimé un
 * site » désigne une personne pour qui connaît l'équipe. Les valeurs
 * inférieures sont donc rendues telles quelles MAIS l'interface les présente
 * comme « moins de 5 » — la règle vit ici pour que les deux côtés la
 * partagent.
 */
export const SEUIL_ANONYMAT = 5;

export function sousLeSeuil(comptes: number): boolean {
  return comptes > 0 && comptes < SEUIL_ANONYMAT;
}

/**
 * Étapes du tunnel d'usage.
 *
 * Le tunnel dit si l'outil sert VRAIMENT : se connecter ne prouve rien,
 * lancer une analyse prouve qu'on cherche, ajuster un profil ou signaler un
 * retour prouve qu'on a trouvé quelque chose et qu'on agit dessus.
 */
export const UsageFunnelKeySchema = z.enum(['connexion', 'analyse', 'exploitation']);
export type UsageFunnelKey = z.infer<typeof UsageFunnelKeySchema>;

export const UsageFunnelStepSchema = z
  .object({
    cle: UsageFunnelKeySchema,
    /** Comptes DISTINCTS ayant atteint cette étape sur la période. */
    comptes: z.number().int().min(0),
    /** Événements comptés — plusieurs par compte, c'est le propre de l'usage. */
    actions: z.number().int().min(0),
  })
  .strict();

export type UsageFunnelStep = z.infer<typeof UsageFunnelStepSchema>;

/** Activité d'une journée — de quoi dessiner une courbe. */
export const UsageDaySchema = z
  .object({
    /** Jour au format `AAAA-MM-JJ`, en UTC comme tout le reste. */
    jour: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    connexions: z.number().int().min(0),
    analyses: z.number().int().min(0),
  })
  .strict();

export type UsageDay = z.infer<typeof UsageDaySchema>;

/** Répartition par gamme — l'axe métier, sans aucune personne dedans. */
export const UsageGammeSchema = z
  .object({
    gamme: z.string(),
    analyses: z.number().int().min(0),
    /** `null` quand aucune page n'a été notée : ce n'est pas un zéro. */
    scoreMoyen: z.number().nullable(),
  })
  .strict();

export type UsageGamme = z.infer<typeof UsageGammeSchema>;

export const UsageOverviewSchema = z
  .object({
    periode: UsagePeriodSchema,
    depuis: z.iso.datetime(),
    jusqua: z.iso.datetime(),
    /** Comptes distincts ayant fait QUOI QUE CE SOIT sur la période. */
    comptesActifs: z.number().int().min(0),
    tunnel: z.array(UsageFunnelStepSchema),
    parJour: z.array(UsageDaySchema),
    gammes: z.array(UsageGammeSchema),
  })
  .strict();

export type UsageOverview = z.infer<typeof UsageOverviewSchema>;

export const UsageQuerySchema = z
  .object({
    periode: UsagePeriodSchema.default('30j'),
  })
  .strict();

export type UsageQuery = z.infer<typeof UsageQuerySchema>;

// ── Gouvernance ─────────────────────────────────────────────────────────────

/**
 * Une source de données, telle qu'un registre de traitement la décrirait.
 *
 * Le registre n'est pas un document à côté du code : il est RENDU par le code,
 * à partir de ce que le code fait réellement. Un registre écrit à la main
 * décrit l'intention du jour où il a été écrit.
 */
export const UsageSourceSchema = z
  .object({
    table: z.string(),
    finalite: z.string(),
    /** Données à caractère personnel effectivement présentes. */
    donnees: z.array(z.string()),
    /** Jours au-delà desquels l'identité est retirée ; `null` = pas de purge. */
    retentionJours: z.number().int().min(1).nullable(),
  })
  .strict();

export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const UsageAnonymisationSchema = z
  .object({
    apresJours: z.number().int().min(1),
    /** Lignes dont l'identité a DÉJÀ été retirée. */
    anonymisees: z.number().int().min(0),
    /** Lignes encore identifiantes et au-delà du délai — à traiter. */
    enAttente: z.number().int().min(0),
    /** Dernier passage du travail de fond, `null` depuis un redémarrage. */
    dernierPassage: z.iso.datetime().nullable(),
  })
  .strict();

export type UsageAnonymisation = z.infer<typeof UsageAnonymisationSchema>;

export const UsageGovernanceSchema = z
  .object({
    sources: z.array(UsageSourceSchema),
    anonymisation: UsageAnonymisationSchema,
    /**
     * Le module collecte-t-il quelque chose pour son propre compte ?
     *
     * Toujours `false`, et c'est le point : la réponse est affichée plutôt
     * qu'affirmée dans une documentation que personne ne relit.
     */
    collecteDediee: z.literal(false),
  })
  .strict();

export type UsageGovernance = z.infer<typeof UsageGovernanceSchema>;
