import {
  CreateUserSchema,
  PASSWORD_MIN_LENGTH,
  UpdateUserSchema,
  type CreateUserInput,
  type UpdateUserInput,
  type UserSummary,
} from '@websentry/shared';

/**
 * Formulaires de la fiche compte — fonctions PURES.
 *
 * La validation côté client REJOUE le schéma partagé : elle avertit avant
 * l'appel réseau, elle ne s'y substitue pas. L'API reste la seule autorité, et
 * ce fichier ne contient aucune règle qu'elle ne porte pas elle-même.
 */

export interface BrouillonCompte {
  username: string;
  password: string;
  rank: number | null;
  status: string;
  displayName: string;
  email: string;
}

export function brouillonDepuisCompte(compte: UserSummary): BrouillonCompte {
  return {
    username: compte.username,
    password: '',
    rank: compte.rank,
    status: compte.status,
    displayName: compte.displayName ?? '',
    email: compte.email ?? '',
  };
}

export const BROUILLON_VIDE: BrouillonCompte = {
  username: '',
  password: '',
  rank: null,
  status: 'active',
  displayName: '',
  email: '',
};

/** Messages d'un résultat Zod, dédupliqués et préfixés du champ concerné. */
function problemes(resultat: {
  success: boolean;
  error?: { issues: readonly unknown[] };
}): string[] {
  if (resultat.success || !resultat.error) return [];

  const messages = new Set<string>();
  for (const brut of resultat.error.issues) {
    const issue = brut as { path?: PropertyKey[]; message: string };
    const champ = issue.path?.[0];
    messages.add(
      champ === undefined ? issue.message : `${nomChamp(String(champ))} : ${issue.message}`,
    );
  }
  return [...messages];
}

function nomChamp(cle: string): string {
  switch (cle) {
    case 'username':
      return 'Identifiant';
    case 'password':
      return 'Mot de passe';
    case 'rank':
      return 'Rang';
    case 'status':
      return 'Statut';
    case 'displayName':
      return 'Nom affiché';
    case 'email':
      return 'Courriel';
    default:
      return cle;
  }
}

/**
 * Charge utile de création.
 *
 * Les champs facultatifs VIDES sont omis plutôt qu'envoyés vides : le schéma
 * refuse une chaîne vide comme courriel, et « pas renseigné » n'est pas
 * « renseigné à vide ».
 */
export function chargeCreation(brouillon: BrouillonCompte): Record<string, unknown> {
  const charge: Record<string, unknown> = {
    username: brouillon.username.trim(),
    password: brouillon.password,
    rank: brouillon.rank,
  };
  if (brouillon.displayName.trim()) charge['displayName'] = brouillon.displayName.trim();
  if (brouillon.email.trim()) charge['email'] = brouillon.email.trim();
  return charge;
}

export function problemesCreation(brouillon: BrouillonCompte): string[] {
  return problemes(CreateUserSchema.safeParse(chargeCreation(brouillon)));
}

export function creationValide(brouillon: BrouillonCompte): CreateUserInput | null {
  const resultat = CreateUserSchema.safeParse(chargeCreation(brouillon));
  return resultat.success ? resultat.data : null;
}

/**
 * Champs RÉELLEMENT modifiés, et eux seuls.
 *
 * Envoyer l'ensemble du formulaire écraserait des valeurs que personne n'a
 * touchées, et la trace d'audit annoncerait des changements qui n'ont pas eu
 * lieu. Un champ texte vidé devient `null` — l'effacer est une intention, et
 * la distinguer de « inchangé » est tout l'objet de cette fonction.
 */
export function champsModifies(
  compte: UserSummary,
  brouillon: BrouillonCompte,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};

  if (brouillon.rank !== null && brouillon.rank !== compte.rank) diff['rank'] = brouillon.rank;
  if (brouillon.status !== compte.status) diff['status'] = brouillon.status;

  const nom = brouillon.displayName.trim();
  if (nom !== (compte.displayName ?? '')) diff['displayName'] = nom === '' ? null : nom;

  const courriel = brouillon.email.trim();
  if (courriel !== (compte.email ?? '')) diff['email'] = courriel === '' ? null : courriel;

  return diff;
}

export function problemesModification(compte: UserSummary, brouillon: BrouillonCompte): string[] {
  const diff = champsModifies(compte, brouillon);
  if (Object.keys(diff).length === 0) return [];
  return problemes(UpdateUserSchema.safeParse(diff));
}

export function modificationValide(
  compte: UserSummary,
  brouillon: BrouillonCompte,
): UpdateUserInput | null {
  const diff = champsModifies(compte, brouillon);
  if (Object.keys(diff).length === 0) return null;
  const resultat = UpdateUserSchema.safeParse(diff);
  return resultat.success ? resultat.data : null;
}

// ── Mot de passe ────────────────────────────────────────────────────────────

/** Alphabet SANS caractères ambigus : O/0, I/l/1 se recopient mal à la main. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%*-_=+';

/**
 * Mot de passe aléatoire, tiré du générateur cryptographique du navigateur.
 *
 * `Math.random()` est prévisible et n'a rien à faire ici : un administrateur
 * qui clique sur « Générer » attend un secret, pas une suite reproductible.
 * Le tirage est REJETÉ et recommencé quand il tombe hors de la plage utilisable
 * de l'octet — sans quoi les premiers caractères de l'alphabet sortiraient plus
 * souvent que les derniers (biais du modulo).
 */
export function genererMotDePasse(longueur = 20): string {
  const plage = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let mot = '';

  while (mot.length < longueur) {
    const octets = new Uint8Array(longueur);
    crypto.getRandomValues(octets);
    for (const octet of octets) {
      if (octet >= plage) continue;
      mot += ALPHABET[octet % ALPHABET.length];
      if (mot.length === longueur) break;
    }
  }
  return mot;
}

export function problemesMotDePasse(motDePasse: string, confirmation: string): string[] {
  const liste: string[] = [];
  if (motDePasse.length < PASSWORD_MIN_LENGTH) {
    liste.push(`Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`);
  }
  // La confirmation n'existe PAS côté API : elle protège de la faute de frappe
  // sur un secret qu'on ne relit pas, pas d'une attaque.
  if (confirmation !== '' && confirmation !== motDePasse) {
    liste.push('Les deux saisies diffèrent.');
  }
  return liste;
}
