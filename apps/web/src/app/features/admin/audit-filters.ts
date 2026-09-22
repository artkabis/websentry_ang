import type { AuditFilters } from '../../core/users/audit.api';

/**
 * Filtres du journal d'audit et leur reflet dans l'URL — fonctions PURES.
 *
 * Même parti pris qu'ailleurs : l'état de recherche vit dans la barre
 * d'adresse. « Ce qu'a fait ce compte entre le 3 et le 7 » devient un lien
 * qu'on joint à un ticket d'incident.
 */

export const TAILLE_PAGE_AUDIT = 50;

export interface AuditFilterState {
  actor: string;
  action: string;
  targetId: string;
  from: string;
  to: string;
  page: number;
}

export const FILTRES_AUDIT_VIDES: AuditFilterState = {
  actor: '',
  action: '',
  targetId: '',
  from: '',
  to: '',
  page: 1,
};

type ParamValue = string | undefined | null;

function texte(brut: ParamValue): string {
  return typeof brut === 'string' ? brut.trim() : '';
}

/**
 * Date `AAAA-MM-JJ` uniquement.
 *
 * Une date mal formée est IGNORÉE ici mais REFUSÉE par l'API : l'URL peut
 * avoir été tronquée par un partage, et mieux vaut afficher le journal complet
 * qu'une erreur 400 pour un lien que personne n'a composé à la main.
 */
function dateIso(brut: ParamValue): string {
  const valeur = texte(brut);
  return /^\d{4}-\d{2}-\d{2}$/.test(valeur) ? valeur : '';
}

function numeroPage(brut: ParamValue): number {
  const valeur = Number(brut);
  return Number.isInteger(valeur) && valeur >= 1 ? valeur : 1;
}

export function filtresAuditDepuisParams(params: Record<string, ParamValue>): AuditFilterState {
  return {
    actor: texte(params['acteur']),
    action: texte(params['action']),
    targetId: texte(params['cible']),
    from: dateIso(params['du']),
    to: dateIso(params['au']),
    page: numeroPage(params['page']),
  };
}

export function paramsDepuisFiltresAudit(filtres: AuditFilterState): Record<string, string> {
  const params: Record<string, string> = {};

  if (filtres.actor) params['acteur'] = filtres.actor;
  if (filtres.action) params['action'] = filtres.action;
  if (filtres.targetId) params['cible'] = filtres.targetId;
  if (filtres.from) params['du'] = filtres.from;
  if (filtres.to) params['au'] = filtres.to;
  if (filtres.page !== 1) params['page'] = String(filtres.page);

  return params;
}

export function filtresAuditVersRequete(
  filtres: AuditFilterState,
  limite = TAILLE_PAGE_AUDIT,
): AuditFilters {
  const requete: AuditFilters = { limit: limite, offset: (filtres.page - 1) * limite };

  if (filtres.actor) requete.actor = filtres.actor;
  if (filtres.action) requete.action = filtres.action;
  if (filtres.targetId) requete.targetId = filtres.targetId;
  if (filtres.from) requete.from = filtres.from;
  if (filtres.to) requete.to = filtres.to;

  return requete;
}

export function filtresAuditActifs(filtres: AuditFilterState): boolean {
  return (
    filtres.actor !== '' ||
    filtres.action !== '' ||
    filtres.targetId !== '' ||
    filtres.from !== '' ||
    filtres.to !== ''
  );
}

/** Incohérences signalées AVANT l'appel réseau — l'API reste seule autorité. */
export function incoherencesAudit(filtres: AuditFilterState): string[] {
  const liste: string[] = [];
  if (filtres.from && filtres.to && filtres.from > filtres.to) {
    liste.push('La date de début est postérieure à la date de fin.');
  }
  return liste;
}

/**
 * Familles d'actions proposées au filtre.
 *
 * Le backend filtre par PRÉFIXE : « user. » ramène toute la famille. La liste
 * est courte et explicite plutôt que déduite des traces existantes — un
 * journal vide proposerait sinon un filtre vide.
 */
export const FAMILLES_ACTION: ReadonlyArray<{ prefixe: string; libelle: string }> = [
  { prefixe: 'auth.', libelle: 'Authentification' },
  { prefixe: 'user.', libelle: 'Comptes' },
  { prefixe: 'profile.', libelle: 'Profils' },
  { prefixe: 'scan.', libelle: 'Scans' },
];

/** Libellé lisible d'une action — le code brut reste affiché à côté. */
export function libelleAction(action: string): string {
  switch (action) {
    case 'auth.login':
      return 'Connexion';
    case 'auth.logout':
      return 'Déconnexion';
    case 'auth.refresh':
      return 'Renouvellement de session';
    case 'user.create':
      return 'Compte créé';
    case 'user.update':
      return 'Compte modifié';
    case 'user.delete':
      return 'Compte supprimé';
    case 'user.password_reset':
      return 'Mot de passe réinitialisé';
    case 'user.permission_grant':
      return 'Permission accordée';
    case 'user.permission_revoke':
      return 'Permission révoquée';
    default:
      return action;
  }
}
