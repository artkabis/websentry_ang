import * as z from 'zod';

/**
 * Portail documentation — schémas partagés API ⇄ frontend.
 *
 * Une page de documentation n'est JAMAIS transportée en HTML. L'API rend une
 * STRUCTURE — des blocs typés, des fragments en ligne typés — et l'interface
 * la dessine avec ses propres gabarits.
 *
 * Ce n'est pas de la prudence excessive : rendre du HTML obligerait à le
 * désinfecter, donc à maintenir une liste de balises et d'attributs admis, et
 * à la maintenir JUSTE. Une structure fermée n'a rien à désinfecter — ce qui
 * n'est pas dans le type n'existe pas, et aucun `innerHTML` n'apparaît nulle
 * part dans le rendu.
 */

// ── Fragments en ligne ──────────────────────────────────────────────────────

export const DocInlineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('texte'), texte: z.string() }).strict(),
  z.object({ type: z.literal('fort'), texte: z.string() }).strict(),
  z.object({ type: z.literal('code'), texte: z.string() }).strict(),
  z
    .object({
      type: z.literal('lien'),
      texte: z.string(),
      /**
       * Deux formes seulement : une page interne (`doc:slug`) ou une adresse
       * https. Tout le reste est refusé à l'analyse et retombe en texte — un
       * `javascript:` n'a même pas de représentation possible ici.
       */
      href: z.union([z.string().regex(/^doc:[a-z0-9-]+$/), z.url().startsWith('https://')]),
    })
    .strict(),
]);

export type DocInline = z.infer<typeof DocInlineSchema>;

// ── Blocs ───────────────────────────────────────────────────────────────────

/**
 * Ton d'un encadré.
 *
 * Deux tons et pas davantage : au-delà, personne ne distingue plus « note »
 * de « remarque », et tout finit en jaune.
 */
export const DocNoteToneSchema = z.enum(['info', 'avertissement']);
export type DocNoteTone = z.infer<typeof DocNoteToneSchema>;

export const DocBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('titre'),
      /** 2 ou 3 : le niveau 1 est le titre de la page, porté par l'en-tête. */
      niveau: z.union([z.literal(2), z.literal(3)]),
      texte: z.string(),
      /** Ancre stable, pour le sommaire et les liens profonds. */
      ancre: z.string().regex(/^[a-z0-9-]+$/),
    })
    .strict(),
  z.object({ type: z.literal('paragraphe'), contenu: z.array(DocInlineSchema) }).strict(),
  z
    .object({
      type: z.literal('liste'),
      ordonnee: z.boolean(),
      elements: z.array(z.array(DocInlineSchema)),
    })
    .strict(),
  z
    .object({
      type: z.literal('code'),
      langage: z.string().nullable(),
      texte: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('note'),
      ton: DocNoteToneSchema,
      contenu: z.array(DocInlineSchema),
    })
    .strict(),
]);

export type DocBlock = z.infer<typeof DocBlockSchema>;

// ── Pages ───────────────────────────────────────────────────────────────────

export const DocSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'Identifiant de page invalide')
  .max(80);

/** Entrée du sommaire — ce qu'il faut pour lister sans charger les pages. */
export const DocSummarySchema = z
  .object({
    slug: DocSlugSchema,
    titre: z.string(),
    section: z.string(),
    /** Ordre d'affichage dans sa section. */
    ordre: z.number().int().min(0),
    /** Première phrase, pour situer sans ouvrir. */
    resume: z.string(),
  })
  .strict();

export type DocSummary = z.infer<typeof DocSummarySchema>;

export const DocPageSchema = DocSummarySchema.extend({
  blocs: z.array(DocBlockSchema),
}).strict();

export type DocPage = z.infer<typeof DocPageSchema>;

/** Le sommaire, groupé par section — l'ordre des sections est celui du serveur. */
export const DocSectionSchema = z
  .object({
    section: z.string(),
    pages: z.array(DocSummarySchema),
  })
  .strict();

export type DocSection = z.infer<typeof DocSectionSchema>;

export const DocIndexSchema = z.object({ sections: z.array(DocSectionSchema) }).strict();
export type DocIndex = z.infer<typeof DocIndexSchema>;

// ── Recherche ───────────────────────────────────────────────────────────────

export const DocSearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(100),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export type DocSearchQuery = z.infer<typeof DocSearchQuerySchema>;

export const DocSearchHitSchema = DocSummarySchema.extend({
  /**
   * Extrait AUTOUR du terme trouvé, en texte brut.
   *
   * Pas de balise de surbrillance : l'interface sait où se trouve le terme,
   * puisqu'elle l'a demandé. Renvoyer du balisage ici rouvrirait la porte que
   * la structure ferme.
   */
  extrait: z.string(),
  /** Score de pertinence — plus il est haut, mieux la page répond. */
  score: z.number().min(0),
}).strict();

export type DocSearchHit = z.infer<typeof DocSearchHitSchema>;

export const DocSearchResponseSchema = z
  .object({
    q: z.string(),
    resultats: z.array(DocSearchHitSchema),
    total: z.number().int().min(0),
  })
  .strict();

export type DocSearchResponse = z.infer<typeof DocSearchResponseSchema>;
