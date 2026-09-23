import {
  JOURS_PAR_PERIODE,
  sousLeSeuil,
  UsagePeriodSchema,
  type UsageDay,
  type UsageFunnelKey,
  type UsageFunnelStep,
  type UsagePeriod,
} from '@websentry/shared';

/**
 * Analytics — fonctions PURES : période d'URL, libellés, géométrie du graphe.
 *
 * La règle d'anonymat vient du paquet partagé et n'est PAS recopiée ici : le
 * serveur s'en sert pour décider ce qu'il remonte, l'interface pour décider ce
 * qu'elle montre, et deux copies divergeraient.
 */

export const PERIODES: readonly UsagePeriod[] = UsagePeriodSchema.options;

/** Période lue d'un paramètre d'URL — 30 jours quand elle est absente ou fausse. */
export function periodeDepuisParams(
  params: Record<string, string | undefined | null>,
): UsagePeriod {
  const brut = typeof params['periode'] === 'string' ? params['periode'].trim() : '';
  const resultat = UsagePeriodSchema.safeParse(brut);
  return resultat.success ? resultat.data : '30j';
}

/** La période par défaut ne s'écrit PAS dans l'URL : une URL propre se partage. */
export function paramsDepuisPeriode(periode: UsagePeriod): Record<string, string> {
  return periode === '30j' ? {} : { periode };
}

export function libellePeriode(periode: UsagePeriod): string {
  return `${JOURS_PAR_PERIODE[periode]} derniers jours`;
}

export function libelleEtape(cle: UsageFunnelKey): string {
  switch (cle) {
    case 'connexion':
      return 'Ouvrent l’outil';
    case 'analyse':
      return 'Lancent une analyse';
    case 'exploitation':
      return 'Agissent sur ce qu’ils trouvent';
  }
}

/** Ce que l'étape prouve — dit à l'écran, plutôt que laissé à deviner. */
export function expliquerEtape(cle: UsageFunnelKey): string {
  switch (cle) {
    case 'connexion':
      return 'Comptes qui se sont connectés au moins une fois.';
    case 'analyse':
      return 'Comptes qui ont lancé au moins un scan.';
    case 'exploitation':
      return 'Comptes qui ont ajusté un profil, signalé un retour ou nettoyé l’historique.';
  }
}

/**
 * Compteur montrable.
 *
 * Sous le seuil d'anonymat, le nombre exact désignerait quelqu'un dans une
 * petite équipe : on dit « moins de 5 » plutôt que de se taire, parce que
 * masquer entièrement laisserait croire à une absence.
 */
export function compteurMontrable(comptes: number): string {
  return sousLeSeuil(comptes) ? 'moins de 5' : String(comptes);
}

/**
 * Part d'une étape par rapport à la PREMIÈRE.
 *
 * Rapportée à l'étape précédente, la part dirait « 80 % » à chaque étage d'un
 * tunnel qui perd les trois quarts de son monde. Le point de comparaison est
 * donc l'entrée, une fois pour toutes.
 */
export function partDuTunnel(etape: UsageFunnelStep, tunnel: readonly UsageFunnelStep[]): number {
  const entree = tunnel[0]?.comptes ?? 0;
  if (entree === 0) return 0;
  return Math.round((etape.comptes / entree) * 100);
}

// ── Géométrie du graphe ─────────────────────────────────────────────────────

/** Une barre de la courbe, en pourcentage de la hauteur disponible. */
export interface BarreJour {
  jour: string;
  connexions: number;
  analyses: number;
  /** Hauteurs en %, pour que le gabarit n'ait aucun calcul à faire. */
  hauteurConnexions: number;
  hauteurAnalyses: number;
}

/**
 * Convertit la série en barres.
 *
 * L'échelle est COMMUNE aux deux séries : deux échelles indépendantes
 * feraient paraître trois connexions aussi hautes que trois cents analyses,
 * et le graphe mentirait sur le rapport entre les deux.
 */
export function barresDeLaSerie(serie: readonly UsageDay[]): BarreJour[] {
  const maximum = serie.reduce((max, j) => Math.max(max, j.connexions, j.analyses), 0);

  return serie.map(jour => ({
    jour: jour.jour,
    connexions: jour.connexions,
    analyses: jour.analyses,
    // Un maximum à zéro donnerait une division par zéro : une série vide est
    // une série plate, pas une erreur.
    hauteurConnexions: maximum === 0 ? 0 : Math.round((jour.connexions / maximum) * 100),
    hauteurAnalyses: maximum === 0 ? 0 : Math.round((jour.analyses / maximum) * 100),
  }));
}

/** Jour au format court, pour l'axe — « 24/03 ». */
export function jourCourt(jour: string): string {
  const [, mois, quantieme] = jour.split('-');
  return `${quantieme ?? '??'}/${mois ?? '??'}`;
}

/**
 * Résumé textuel de la courbe.
 *
 * Un graphe est une image : sans cette phrase, il ne dit rien à qui ne le voit
 * pas. Le tableau complet reste disponible juste à côté — ceci en est le
 * survol.
 */
export function resumerSerie(serie: readonly UsageDay[]): string {
  if (serie.length === 0) return 'Aucune activité sur la période.';

  const connexions = serie.reduce((total, j) => total + j.connexions, 0);
  const analyses = serie.reduce((total, j) => total + j.analyses, 0);
  const pointe = serie.reduce((max, j) => (j.analyses > max.analyses ? j : max), serie[0]!);

  return (
    `${connexions} connexion(s) et ${analyses} analyse(s) sur ${serie.length} jours. ` +
    `Pointe d’analyses le ${jourCourt(pointe.jour)} avec ${pointe.analyses}.`
  );
}

// ── Gouvernance ─────────────────────────────────────────────────────────────

export function libelleRetention(jours: number | null): string {
  // `null` n'est pas « zéro jour » : c'est l'absence de purge automatique, et
  // le taire laisserait croire à une purge qui n'existe pas.
  return jours === null ? 'Aucune purge automatique' : `${jours} jours`;
}

/** L'anonymisation est-elle en retard sur ce qu'elle devrait avoir traité ? */
export function anonymisationEnRetard(enAttente: number): boolean {
  return enAttente > 0;
}
