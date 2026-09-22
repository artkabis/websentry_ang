import type { EtatComposant } from '@websentry/shared';

/**
 * Mise en forme de la supervision — fonctions PURES.
 *
 * Aucune couleur n'est le seul porteur de sens : chaque état a un LIBELLÉ,
 * invisible au lecteur d'écran s'il n'était que teinté, et ambigu en cas de
 * daltonisme.
 */

/**
 * Pas de branche par défaut, et c'est voulu.
 *
 * `EtatComposant` est une union de trois littéraux, et la réponse est validée
 * par Zod à la frontière : un état inconnu ne peut pas arriver jusqu'ici. Un
 * repli à l'exécution serait donc une branche morte — alors que l'exhaustivité
 * du switch fait échouer la COMPILATION le jour où un quatrième état apparaît,
 * ce qui vaut mieux qu'un libellé brut découvert à l'écran.
 */
export function libelleEtat(etat: EtatComposant): string {
  switch (etat) {
    case 'ok':
      return 'Opérationnel';
    case 'degrade':
      return 'Dégradé';
    case 'panne':
      return 'En panne';
  }
}

/** Phrase de synthèse — ce qu'on lit en premier, et parfois seul. */
export function resumeGlobal(etat: EtatComposant): string {
  switch (etat) {
    case 'ok':
      return 'Tout fonctionne normalement.';
    case 'degrade':
      return 'L’instance fonctionne, mais en repli sur au moins un composant.';
    case 'panne':
      return 'Au moins un composant est hors service.';
  }
}

/** Classes de la pastille d'état — la couleur APPUIE le libellé, elle ne le remplace pas. */
export function classeEtat(etat: EtatComposant): string {
  const socle = 'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium';
  if (etat === 'panne') return `${socle} bg-danger-surface text-danger-content`;
  if (etat === 'degrade') return `${socle} bg-warn-surface text-warn-content`;
  return `${socle} bg-ok-surface text-ok-content`;
}

/**
 * Durée depuis le démarrage, en français lisible.
 *
 * Les secondes ne sont affichées que sous la minute : « 3 j 4 h 12 min 7 s »
 * donne une précision que personne n'utilise et qui change à chaque relevé.
 */
export function formatUptime(secondes: number): string {
  if (secondes < 60) return `${secondes} s`;

  const jours = Math.floor(secondes / 86_400);
  const heures = Math.floor((secondes % 86_400) / 3_600);
  const minutes = Math.floor((secondes % 3_600) / 60);

  const morceaux: string[] = [];
  if (jours > 0) morceaux.push(`${jours} j`);
  if (heures > 0) morceaux.push(`${heures} h`);
  // Les minutes disparaissent au-delà d'un jour : elles n'apprennent plus rien.
  if (minutes > 0 && jours === 0) morceaux.push(`${minutes} min`);

  return morceaux.join(' ');
}

/** Nombre avec séparateur de milliers — un « 12345 » brut se lit mal. */
export function formatNombre(valeur: number): string {
  return valeur.toLocaleString('fr-FR');
}

/** Durée d'un passage de rétention. */
export function formatDuree(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const secondes = ms / 1_000;
  if (secondes < 60) return `${secondes.toFixed(1)} s`;
  return `${Math.floor(secondes / 60)} min ${Math.round(secondes % 60)} s`;
}
