/**
 * Messagerie — RÈGLES et vocabulaire, sans validateur.
 *
 * Ce module ne dépend pas de Zod, et c'est sa raison d'être. Une règle métier
 * partagée doit pouvoir s'importer depuis n'importe où, y compris depuis du
 * code que le navigateur télécharge avant la première navigation. Tant que
 * `sInterrompt` vivait à côté des `z.object(...)`, importer cette seule
 * fonction traînait les 125 kio du validateur dans le chargement initial —
 * c'est arrivé, et le constat est consigné dans `DECISIONS.md` (68).
 *
 * Le vocabulaire est ici, pas dans le schéma : c'est la règle qui décide des
 * niveaux dont elle a besoin, et le schéma qui s'aligne dessus. L'inverse
 * obligeait à faire dépendre la règle du validateur.
 */

/**
 * Importance — elle pilote l'IRRUPTION, pas seulement la couleur.
 *
 * Trois niveaux, parce qu'ils se distinguent par un comportement observable et
 * non par une nuance : `normale` attend dans la boîte, `haute` se signale en
 * tête de liste, `critique` s'impose à l'écran jusqu'à ce qu'on l'ait lue.
 * Un quatrième niveau n'aurait aucun comportement propre à décrire.
 */
export const IMPORTANCES_MESSAGE = ['normale', 'haute', 'critique'] as const;

export type MessageImportance = (typeof IMPORTANCES_MESSAGE)[number];

/**
 * Un message s'impose-t-il à l'écran ?
 *
 * La règle vit ICI et non dans le composant : le serveur s'en sert pour
 * décider ce qu'il remonte en priorité, l'interface pour décider ce qu'elle
 * affiche. Deux copies de la même règle divergeraient.
 */
export function sInterrompt(importance: MessageImportance): boolean {
  return importance === 'critique';
}
