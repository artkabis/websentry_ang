import { RANKS, UserStatusSchema, VALID_RANKS, type UserSummary } from '@websentry/shared';
import type { UserFilters } from '../../core/users/users.api';

/**
 * Filtres de la liste des comptes et leur reflet dans l'URL — fonctions PURES.
 *
 * Même parti pris que l'historique des scans : l'état de recherche vit dans la
 * barre d'adresse. « Montre-moi les comptes suspendus » devient alors un lien
 * qu'on colle dans un ticket.
 */

/** Taille de page de l'administration — le backend borne à 200. */
export const TAILLE_PAGE = 25;

export interface UserFilterState {
  search: string;
  /** `null` = tous rangs confondus. */
  rank: number | null;
  /** `''` = tous statuts confondus. */
  status: string;
  page: number;
}

export const FILTRES_VIDES: UserFilterState = {
  search: '',
  rank: null,
  status: '',
  page: 1,
};

type ParamValue = string | undefined | null;

function texte(brut: ParamValue): string {
  return typeof brut === 'string' ? brut.trim() : '';
}

/**
 * Rang lu depuis l'URL.
 *
 * Une valeur hors catalogue est IGNORÉE plutôt que transmise : le backend la
 * refuserait en 400, et l'utilisateur verrait une erreur pour un lien qu'il n'a
 * pas composé lui-même.
 */
function rang(brut: ParamValue): number | null {
  const valeur = Number(texte(brut));
  return VALID_RANKS.includes(valeur) ? valeur : null;
}

function statut(brut: ParamValue): string {
  return UserStatusSchema.safeParse(texte(brut)).success ? texte(brut) : '';
}

function numeroPage(brut: ParamValue): number {
  const valeur = Number(brut);
  return Number.isInteger(valeur) && valeur >= 1 ? valeur : 1;
}

export function filtresDepuisParams(params: Record<string, ParamValue>): UserFilterState {
  return {
    search: texte(params['recherche']),
    rank: rang(params['rang']),
    status: statut(params['statut']),
    page: numeroPage(params['page']),
  };
}

/**
 * Écrit l'état dans des paramètres d'URL.
 *
 * Les valeurs par défaut sont OMISES : deux états identiques produisent
 * exactement la même adresse, sans quoi l'historique du navigateur se
 * remplirait de doublons que « Précédent » ferait défiler un par un.
 */
export function paramsDepuisFiltres(filtres: UserFilterState): Record<string, string> {
  const params: Record<string, string> = {};

  if (filtres.search) params['recherche'] = filtres.search;
  if (filtres.rank !== null) params['rang'] = String(filtres.rank);
  if (filtres.status) params['statut'] = filtres.status;
  if (filtres.page !== 1) params['page'] = String(filtres.page);

  return params;
}

/** Filtres prêts pour l'appel API — la page devient un décalage. */
export function filtresVersRequete(filtres: UserFilterState, limite = TAILLE_PAGE): UserFilters {
  const requete: UserFilters = { limit: limite, offset: (filtres.page - 1) * limite };

  if (filtres.search) requete.search = filtres.search;
  if (filtres.rank !== null) requete.rank = filtres.rank;
  if (filtres.status) requete.status = filtres.status;

  return requete;
}

export function filtresActifs(filtres: UserFilterState): boolean {
  return filtres.search !== '' || filtres.rank !== null || filtres.status !== '';
}

/** Nombre de pages, au moins une — un résultat vide reste « page 1 sur 1 ». */
export function nombreDePages(total: number, limite = TAILLE_PAGE): number {
  return Math.max(1, Math.ceil(total / limite));
}

// ── Anticipation des garde-fous du backend ──────────────────────────────────

/**
 * Pourquoi ce geste serait refusé — `null` s'il est permis.
 *
 * Les garde-fous du service (cf. `docs/DECISIONS.md` §40) dépendent de l'acteur
 * ET de la cible : aucun schéma ne les exprime, et l'interface doit donc les
 * REJOUER pour ne pas proposer un bouton dont elle sait qu'il rendra 403. Ce
 * n'est PAS une protection — l'API reste la seule autorité — c'est une
 * explication donnée avant le clic plutôt qu'après.
 */
export function refusPrevisible(
  cible: Pick<UserSummary, 'id' | 'rank'>,
  acteur: { id: string; rank: number },
  geste: 'modifier' | 'supprimer' | 'motDePasse',
): string | null {
  if (cible.id === acteur.id && geste !== 'motDePasse') {
    return geste === 'supprimer'
      ? 'Vous ne pouvez pas supprimer votre propre compte.'
      : 'Vous ne pouvez pas changer votre propre rang ni votre propre statut.';
  }

  // Le super_admin échappe à la comparaison de rang : c'est le sommet de la
  // hiérarchie, il n'a personne au-dessus de qui se comparer.
  if (acteur.rank < RANKS.SUPER_ADMIN && cible.rank >= acteur.rank) {
    return 'Ce compte est de rang supérieur ou égal au vôtre.';
  }

  return null;
}

/** Rangs qu'un acteur peut attribuer — jamais au-dessus du sien. */
export function rangsAttribuables(rangActeur: number): readonly number[] {
  const tries = [...VALID_RANKS].sort((a, b) => a - b);
  if (rangActeur >= RANKS.SUPER_ADMIN) return tries;
  return tries.filter(r => r < rangActeur);
}

/** Libellé lisible d'un rang, pour les listes déroulantes et les cellules. */
export function libelleRang(rank: number): string {
  switch (rank) {
    case RANKS.SUPER_ADMIN:
      return 'Super administrateur';
    case RANKS.ADMIN:
      return 'Administrateur';
    case RANKS.EDITOR:
      return 'Éditeur';
    default:
      return 'Testeur';
  }
}

export function libelleStatut(status: string): string {
  switch (status) {
    case 'suspended':
      return 'Suspendu';
    case 'pending':
      return 'En attente';
    default:
      return 'Actif';
  }
}
