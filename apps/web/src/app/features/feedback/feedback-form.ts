import {
  CreateFeedbackSchema,
  FeedbackStatusSchema,
  TRANSITIONS_STATUT,
  type CreateFeedbackInput,
  type FeedbackKind,
  type FeedbackSeverity,
  type FeedbackStatus,
} from '@websentry/shared';
import type { FeedbackFilters } from '../../core/feedback/feedback.api';

/**
 * Retours — fonctions PURES : filtres d'URL, libellés, validation.
 *
 * La validation côté client REJOUE le schéma partagé : elle avertit avant
 * l'appel réseau, elle ne s'y substitue pas.
 */

export const TAILLE_PAGE_RETOURS = 25;

// ── Filtres ─────────────────────────────────────────────────────────────────

export interface FeedbackFilterState {
  status: string;
  kind: string;
  severity: string;
  search: string;
  /** Vue « mes retours » — sans effet pour qui ne voit déjà que les siens. */
  mine: boolean;
  page: number;
}

export const FILTRES_RETOURS_VIDES: FeedbackFilterState = {
  status: '',
  kind: '',
  severity: '',
  search: '',
  mine: false,
  page: 1,
};

type ParamValue = string | undefined | null;

function texte(brut: ParamValue): string {
  return typeof brut === 'string' ? brut.trim() : '';
}

/** Valeur d'énumération, ou chaîne vide si elle n'est pas au catalogue. */
function valeurDe(brut: ParamValue, catalogue: readonly string[]): string {
  const valeur = texte(brut);
  return catalogue.includes(valeur) ? valeur : '';
}

export const STATUTS: readonly FeedbackStatus[] = FeedbackStatusSchema.options;
export const TYPES: readonly FeedbackKind[] = ['bug', 'suggestion', 'question'];
export const GRAVITES: readonly FeedbackSeverity[] = ['bloquant', 'majeur', 'mineur', 'cosmetique'];

export function filtresRetoursDepuisParams(
  params: Record<string, ParamValue>,
): FeedbackFilterState {
  const page = Number(params['page']);
  return {
    status: valeurDe(params['statut'], STATUTS),
    kind: valeurDe(params['type'], TYPES),
    severity: valeurDe(params['gravite'], GRAVITES),
    search: texte(params['recherche']),
    // Tout ce qui n'est pas exactement « oui » vaut non : un paramètre d'URL
    // est du texte, et « false » y serait une chaîne parfaitement vraie.
    mine: texte(params['miens']) === 'oui',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function paramsDepuisFiltresRetours(filtres: FeedbackFilterState): Record<string, string> {
  const params: Record<string, string> = {};

  if (filtres.status) params['statut'] = filtres.status;
  if (filtres.kind) params['type'] = filtres.kind;
  if (filtres.severity) params['gravite'] = filtres.severity;
  if (filtres.search) params['recherche'] = filtres.search;
  if (filtres.mine) params['miens'] = 'oui';
  if (filtres.page !== 1) params['page'] = String(filtres.page);

  return params;
}

export function filtresRetoursVersRequete(
  filtres: FeedbackFilterState,
  limite = TAILLE_PAGE_RETOURS,
): FeedbackFilters {
  const requete: FeedbackFilters = { limit: limite, offset: (filtres.page - 1) * limite };

  if (filtres.status) requete.status = filtres.status;
  if (filtres.kind) requete.kind = filtres.kind;
  if (filtres.severity) requete.severity = filtres.severity;
  if (filtres.search) requete.search = filtres.search;
  if (filtres.mine) requete.mine = true;

  return requete;
}

export function filtresRetoursActifs(filtres: FeedbackFilterState): boolean {
  return (
    filtres.status !== '' ||
    filtres.kind !== '' ||
    filtres.severity !== '' ||
    filtres.search !== '' ||
    filtres.mine
  );
}

export function nombreDePagesRetours(total: number, limite = TAILLE_PAGE_RETOURS): number {
  return Math.max(1, Math.ceil(total / limite));
}

// ── Dépôt ───────────────────────────────────────────────────────────────────

export interface BrouillonRetour {
  kind: string;
  severity: string;
  title: string;
  body: string;
}

export const BROUILLON_RETOUR_VIDE: BrouillonRetour = {
  kind: 'bug',
  severity: 'majeur',
  title: '',
  body: '',
};

function nomChamp(cle: string): string {
  switch (cle) {
    case 'title':
      return 'Titre';
    case 'body':
      return 'Description';
    case 'kind':
      return 'Type';
    case 'severity':
      return 'Gravité';
    default:
      return cle;
  }
}

/** Charge utile du dépôt, contexte compris quand il y en a un. */
export function chargeRetour(
  brouillon: BrouillonRetour,
  contexte?: { route?: string | null; targetUrl?: string | null; gamme?: string | null },
): Record<string, unknown> {
  const charge: Record<string, unknown> = {
    kind: brouillon.kind,
    severity: brouillon.severity,
    title: brouillon.title.trim(),
    body: brouillon.body.trim(),
  };
  // Le contexte n'est joint que s'il porte quelque chose : un objet de trois
  // nulls n'apprend rien et alourdit la table.
  if (contexte && Object.values(contexte).some(v => v)) {
    charge['context'] = {
      route: contexte.route ?? null,
      targetUrl: contexte.targetUrl ?? null,
      gamme: contexte.gamme ?? null,
    };
  }
  return charge;
}

export function problemesRetour(
  brouillon: BrouillonRetour,
  contexte?: { route?: string | null; targetUrl?: string | null; gamme?: string | null },
): string[] {
  const resultat = CreateFeedbackSchema.safeParse(chargeRetour(brouillon, contexte));
  if (resultat.success) return [];

  const messages = new Set<string>();
  for (const brut of resultat.error.issues) {
    const probleme = brut as { path?: PropertyKey[]; message: string };
    const champ = probleme.path?.[0];
    messages.add(
      champ === undefined ? probleme.message : `${nomChamp(String(champ))} : ${probleme.message}`,
    );
  }
  return [...messages];
}

export function retourValide(
  brouillon: BrouillonRetour,
  contexte?: { route?: string | null; targetUrl?: string | null; gamme?: string | null },
): CreateFeedbackInput | null {
  const resultat = CreateFeedbackSchema.safeParse(chargeRetour(brouillon, contexte));
  return resultat.success ? resultat.data : null;
}

// ── Libellés ────────────────────────────────────────────────────────────────

export function libelleStatutRetour(status: string): string {
  switch (status) {
    case 'nouveau':
      return 'Nouveau';
    case 'accepte':
      return 'Accepté';
    case 'en_cours':
      return 'En cours';
    case 'resolu':
      return 'Résolu';
    case 'rejete':
      return 'Rejeté';
    default:
      return status;
  }
}

export function libelleType(kind: string): string {
  switch (kind) {
    case 'bug':
      return 'Anomalie';
    case 'suggestion':
      return 'Suggestion';
    case 'question':
      return 'Question';
    default:
      return kind;
  }
}

export function libelleGravite(severity: string): string {
  switch (severity) {
    case 'bloquant':
      return 'Bloquant';
    case 'majeur':
      return 'Majeur';
    case 'mineur':
      return 'Mineur';
    case 'cosmetique':
      return 'Cosmétique';
    default:
      return severity;
  }
}

/**
 * Statuts atteignables depuis celui-ci.
 *
 * L'interface n'offre QUE ces choix : proposer un passage que l'API refusera
 * ferait découvrir l'interdit après le clic.
 */
export function statutsAtteignables(depuis: string): readonly FeedbackStatus[] {
  const connu = STATUTS.find(s => s === depuis);
  return connu ? TRANSITIONS_STATUT[connu] : [];
}
