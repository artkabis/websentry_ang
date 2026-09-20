import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ScanPage } from '@websentry/shared';

export class ScanPageNotFoundError extends NotFoundException {
  constructor() {
    // Le message ne reprend PAS l'identifiant demandé : l'historique est lisible
    // par des comptes qui n'ont pas accès à tous les sites, et renvoyer l'entrée
    // en écho transformerait un 404 en oracle d'existence.
    super('Scan introuvable');
  }
}

export class ScanSessionNotFoundError extends NotFoundException {
  constructor() {
    super('Session de scan introuvable');
  }
}

/**
 * Le scan existe, mais la rétention a effacé son rapport.
 *
 * **410 Gone et non 404** : la nuance n'est pas théorique. Un 404 envoie
 * l'utilisateur chercher une donnée qu'il croit égarée, et le support avec lui ;
 * un 410 dit que la donnée a existé, qu'elle a été supprimée volontairement, et
 * depuis quand. La v1 répondait 404 faute de savoir distinguer les deux cas.
 *
 * Le RÉSUMÉ accompagne le refus. Le message promet qu'il reste consultable :
 * l'obliger à être retrouvé ailleurs rendrait cette promesse fausse dès qu'on
 * ouvre le lien directement — depuis un signet, ou reçu d'un collègue.
 */
export class ScanReportPurgedError extends HttpException {
  constructor(
    readonly purgedAt: string | null,
    scan?: ScanPage,
  ) {
    super(
      {
        statusCode: HttpStatus.GONE,
        error: 'Rapport purgé',
        message: purgedAt
          ? `Le rapport complet a été purgé le ${purgedAt.slice(0, 10)} par la politique de rétention. ` +
            'Le résumé des critères reste consultable.'
          : 'Le rapport complet a été purgé par la politique de rétention. ' +
            'Le résumé des critères reste consultable.',
        details: scan ? { purgedAt, scan } : { purgedAt },
      },
      HttpStatus.GONE,
    );
  }
}

/**
 * Deux sessions de sites différents ne se comparent pas.
 *
 * Le refus est délibéré : l'appariement se fait par URL, et deux sites distincts
 * n'en partagent aucune. La comparaison « réussirait » en annonçant que TOUTES
 * les pages ont disparu et que toutes les autres sont apparues — un résultat
 * syntaxiquement valide et complètement trompeur.
 */
export class SessionsNotComparableError extends BadRequestException {
  constructor() {
    super('Les deux sessions appartiennent à des sites différents et ne sont pas comparables');
  }
}
