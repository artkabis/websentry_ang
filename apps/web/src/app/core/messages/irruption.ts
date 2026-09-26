import type { Message } from '@websentry/shared';
// Sous-chemin `rules/` et non le baril : ce module est sur le chemin de
// DÉMARRAGE (la coquille lit les compteurs pour sa pastille). Passer par le
// baril ferait résoudre un schéma, donc Zod, donc 125 kio avant le premier
// rendu — c'est exactement la faute que le contrôle du noyau interdit.
import { sInterrompt } from '@websentry/shared/rules/message';

/**
 * Un message doit-il s'imposer à l'écran ?
 *
 * La règle d'importance vient du paquet partagé ; ce qui s'y ajoute ici est la
 * condition de lecture, qui n'a de sens que côté interface : un message déjà
 * lu ne s'impose plus, même critique.
 */
export function doitInterrompre(message: Message): boolean {
  return message.readAt === null && sInterrompt(message.importance);
}

/** Le premier message qui doit s'imposer, ou `null`. */
export function premiereIrruption(messages: readonly Message[]): Message | null {
  return messages.find(doitInterrompre) ?? null;
}
