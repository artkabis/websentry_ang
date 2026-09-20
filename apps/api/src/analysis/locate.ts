import type { CheckItemLocator } from '@websentry/shared';

/**
 * Ancrage « aller à l'élément fautif » — fonctions PURES.
 *
 * Le rapport pointe vers la page réelle par un fragment de texte
 * (`#:~:text=`), pas par un sélecteur CSS. Le choix est délibéré : un sélecteur
 * casse au premier changement de gabarit, alors que le texte visible survit,
 * et le navigateur sait surligner ce dernier sans aucun script.
 */

/** En deçà, un ancrage capterait n'importe quoi dans la page. */
const MIN_ANCHOR_LENGTH = 3;
/** Au-delà, on vise une PLAGE début…fin plutôt qu'un long passage exact. */
const MAX_WHOLE_TEXT_WORDS = 8;

/**
 * Fabrique un ancrage à partir du texte visible d'un élément.
 *
 * Texte court : on le cible entier. Texte long : on cible `début…fin`, plus
 * robuste au découpage par blocs du navigateur — un passage de quarante mots
 * traversant plusieurs nœuds ne serait jamais retrouvé tel quel.
 */
export function locateFromText(text: string | null | undefined): CheckItemLocator | undefined {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_ANCHOR_LENGTH) return undefined;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length <= MAX_WHOLE_TEXT_WORDS) return { text: normalized };

  return { text: words.slice(0, 5).join(' '), textEnd: words.slice(-3).join(' ') };
}

/** Extrait de source tronqué pour la vue « code ». `undefined` si rien d'utile. */
export function truncateSource(html: string | null | undefined, max = 400): string | undefined {
  if (!html) return undefined;
  const normalized = html.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
