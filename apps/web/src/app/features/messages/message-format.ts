import {
  CreateMessageSchema,
  MessageImportanceSchema,
  MIMES_PIECE_JOINTE,
  NOMBRE_MAX_PIECES_JOINTES,
  sInterrompt,
  TAILLE_MAX_PIECE_JOINTE,
  TYPES_PIECE_JOINTE,
  type CreateMessageInput,
  type Message,
  type MessageImportance,
} from '@websentry/shared';
import type { MessageFilters } from '../../core/messages/messages.api';

/**
 * Messagerie — fonctions PURES : filtres d'URL, libellés, validation.
 *
 * La validation côté client REJOUE le schéma partagé : elle avertit avant
 * l'appel réseau, elle ne s'y substitue pas. L'API reste la seule autorité —
 * et pour les pièces jointes, elle seule lit les octets.
 */

export const TAILLE_PAGE_MESSAGES = 25;

// ── Filtres ─────────────────────────────────────────────────────────────────

export interface MessageFilterState {
  /** Ne montrer que les non lus. */
  unread: boolean;
  importance: string;
  search: string;
  /** Vue des archivés — ils sortent de la boîte, ils n'en disparaissent pas. */
  archived: boolean;
  page: number;
}

export const FILTRES_MESSAGES_VIDES: MessageFilterState = {
  unread: false,
  importance: '',
  search: '',
  archived: false,
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

export const IMPORTANCES: readonly MessageImportance[] = MessageImportanceSchema.options;

export function filtresMessagesDepuisParams(
  params: Record<string, ParamValue>,
): MessageFilterState {
  const page = Number(params['page']);
  return {
    // Tout ce qui n'est pas exactement « oui » vaut non : un paramètre d'URL
    // est du texte, et « false » y serait une chaîne parfaitement vraie.
    unread: texte(params['nonlus']) === 'oui',
    importance: valeurDe(params['importance'], IMPORTANCES),
    search: texte(params['recherche']),
    archived: texte(params['archives']) === 'oui',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function paramsDepuisFiltresMessages(filtres: MessageFilterState): Record<string, string> {
  const params: Record<string, string> = {};

  if (filtres.unread) params['nonlus'] = 'oui';
  if (filtres.importance) params['importance'] = filtres.importance;
  if (filtres.search) params['recherche'] = filtres.search;
  if (filtres.archived) params['archives'] = 'oui';
  if (filtres.page !== 1) params['page'] = String(filtres.page);

  return params;
}

export function filtresMessagesVersRequete(
  filtres: MessageFilterState,
  limite = TAILLE_PAGE_MESSAGES,
): MessageFilters {
  const requete: MessageFilters = { limit: limite, offset: (filtres.page - 1) * limite };

  if (filtres.unread) requete.unread = true;
  if (filtres.importance) requete.importance = filtres.importance;
  if (filtres.search) requete.search = filtres.search;
  if (filtres.archived) requete.archived = true;

  return requete;
}

export function filtresMessagesActifs(filtres: MessageFilterState): boolean {
  return filtres.unread || filtres.importance !== '' || filtres.search !== '' || filtres.archived;
}

export function nombreDePagesMessages(total: number, limite = TAILLE_PAGE_MESSAGES): number {
  return Math.max(1, Math.ceil(total / limite));
}

// ── Composition ─────────────────────────────────────────────────────────────

export interface BrouillonMessage {
  subject: string;
  body: string;
  importance: string;
  audience: string;
  /** Rang visé — lu seulement quand l'audience est « rang ». */
  audienceRank: string;
  /** Comptes visés — lus seulement quand l'audience est « comptes ». */
  recipientIds: readonly string[];
}

export const BROUILLON_MESSAGE_VIDE: BrouillonMessage = {
  subject: '',
  body: '',
  importance: 'normale',
  audience: 'tous',
  audienceRank: '',
  recipientIds: [],
};

function nomChamp(cle: string): string {
  switch (cle) {
    case 'subject':
      return 'Objet';
    case 'body':
      return 'Message';
    case 'importance':
      return 'Importance';
    case 'audience':
      return 'Destinataires';
    case 'audienceRank':
      return 'Rang visé';
    case 'recipientIds':
      return 'Comptes visés';
    default:
      return cle;
  }
}

/**
 * Charge utile de l'envoi.
 *
 * Chaque audience ne porte QUE sa propre cible, et c'est ce qui rend la clé
 * surnuméraire IMPOSSIBLE depuis l'interface : le schéma partagé est une union
 * discriminée, et un rang joint à un envoi « à tous » laisserait croire à une
 * restriction qui n'existe pas. Le brouillon peut garder un rang saisi puis
 * abandonné ; cette fonction ne le recopie pas.
 */
export function chargeMessage(brouillon: BrouillonMessage): Record<string, unknown> {
  const charge: Record<string, unknown> = {
    subject: brouillon.subject.trim(),
    body: brouillon.body.trim(),
    importance: brouillon.importance,
    audience: brouillon.audience,
  };

  if (brouillon.audience === 'rang') charge['audienceRank'] = brouillon.audienceRank;
  if (brouillon.audience === 'comptes') charge['recipientIds'] = [...brouillon.recipientIds];

  return charge;
}

export function problemesMessage(brouillon: BrouillonMessage): string[] {
  const resultat = CreateMessageSchema.safeParse(chargeMessage(brouillon));
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

export function messageValide(brouillon: BrouillonMessage): CreateMessageInput | null {
  const resultat = CreateMessageSchema.safeParse(chargeMessage(brouillon));
  return resultat.success ? resultat.data : null;
}

// ── Pièces jointes ──────────────────────────────────────────────────────────

/** Extensions acceptées, pour l'attribut `accept` du champ de fichier. */
export const EXTENSIONS_ACCEPTEES: readonly string[] = Object.values(TYPES_PIECE_JOINTE).map(
  t => `.${t.extension}`,
);

/** `accept` du champ : extensions ET types, pour couvrir les deux dialectes. */
export const ACCEPT_PIECES = [...EXTENSIONS_ACCEPTEES, ...MIMES_PIECE_JOINTE].join(',');

/**
 * Ce qui empêche ce lot d'être envoyé, du point de vue du client.
 *
 * Le contrôle est DÉLIBÉRÉMENT plus faible que celui du serveur : ici on ne
 * lit que le nom, le type annoncé et la taille, parce que c'est tout ce qu'un
 * champ de fichier donne sans lire les octets. Le serveur, lui, reconnaît le
 * type à l'empreinte. Un fichier accepté ici peut donc être refusé là-bas —
 * c'est l'ordre normal des choses, pas un défaut.
 */
export function problemesPieces(fichiers: readonly File[]): string[] {
  const problemes: string[] = [];

  if (fichiers.length > NOMBRE_MAX_PIECES_JOINTES) {
    problemes.push(`Au plus ${NOMBRE_MAX_PIECES_JOINTES} pièces jointes par message.`);
  }

  for (const fichier of fichiers) {
    if (fichier.size === 0) {
      problemes.push(`« ${fichier.name} » est vide.`);
      continue;
    }
    if (fichier.size > TAILLE_MAX_PIECE_JOINTE) {
      problemes.push(`« ${fichier.name} » dépasse ${formaterTaille(TAILLE_MAX_PIECE_JOINTE)}.`);
      continue;
    }
    if (!typeAnnonceAccepte(fichier)) {
      problemes.push(`« ${fichier.name} » n'est pas un format accepté (PNG, JPEG, WebP, PDF).`);
    }
  }

  return problemes;
}

/**
 * Le type annoncé est-il plausible ?
 *
 * On regarde le type déclaré par le navigateur ET l'extension : l'un ou
 * l'autre suffit, parce qu'un système mal configuré peut ne rien déclarer du
 * tout, et qu'un refus pour cette seule raison serait incompréhensible.
 */
function typeAnnonceAccepte(fichier: File): boolean {
  if ((MIMES_PIECE_JOINTE as readonly string[]).includes(fichier.type)) return true;

  const point = fichier.name.lastIndexOf('.');
  if (point === -1) return false;
  const extension = fichier.name.slice(point + 1).toLowerCase();
  return Object.values(TYPES_PIECE_JOINTE).some(t => t.extension === extension);
}

/** Taille lisible — la précision au kilo-octet près n'apprend rien. */
export function formaterTaille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} ko`;
  return `${(octets / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

// ── Libellés ────────────────────────────────────────────────────────────────

export function libelleImportance(importance: string): string {
  switch (importance) {
    case 'normale':
      return 'Normale';
    case 'haute':
      return 'Haute';
    case 'critique':
      return 'Critique';
    default:
      return importance;
  }
}

export function libelleAudience(audience: string): string {
  switch (audience) {
    case 'tous':
      return 'Tous les comptes actifs';
    case 'rang':
      return 'Un rang et au-dessus';
    case 'comptes':
      return 'Des comptes nommés';
    default:
      return audience;
  }
}

/**
 * Le message doit-il s'imposer à l'écran ?
 *
 * La règle vient du paquet partagé : la recopier ici la ferait diverger de
 * celle que le serveur applique pour remonter ses compteurs.
 */
export function doitInterrompre(message: Message): boolean {
  return message.readAt === null && sInterrompt(message.importance);
}

/** Le premier message qui doit s'imposer, ou `null`. */
export function premiereIrruption(messages: readonly Message[]): Message | null {
  return messages.find(doitInterrompre) ?? null;
}
