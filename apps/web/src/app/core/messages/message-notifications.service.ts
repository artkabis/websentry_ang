import { inject, Injectable, signal } from '@angular/core';
import type { Message, MessageCounts } from '@websentry/shared';
import { premiereIrruption } from '../../features/messages/message-format';
import { MessagesApi } from './messages.api';

/** Compteurs vides — l'état d'un compte qui n'a encore rien reçu. */
const AUCUN: MessageCounts = { total: 0, nonLus: 0, interrompt: 0 };

/**
 * Délai minimal entre deux relectures.
 *
 * Les compteurs sont rafraîchis à chaque navigation. Sans ce plancher, un
 * aller-retour entre deux écrans déclencherait deux requêtes par seconde pour
 * une pastille qui ne bouge presque jamais.
 */
const INTERVALLE_MIN_MS = 15_000;

/**
 * État de la messagerie partagé par la coquille.
 *
 * La pastille de la barre et la fenêtre d'irruption lisent la MÊME source :
 * deux lectures indépendantes se contrediraient dès qu'un message serait lu
 * dans l'une sans que l'autre le sache.
 */
@Injectable({ providedIn: 'root' })
export class MessageNotificationsService {
  private readonly api = inject(MessagesApi);

  readonly compteurs = signal<MessageCounts>(AUCUN);
  /** Le message qui doit s'imposer à l'écran, ou `null`. */
  readonly irruption = signal<Message | null>(null);

  private dernierAppel = 0;
  private enVol: Promise<void> | null = null;

  /**
   * Relit les compteurs, et le message à imposer s'il y en a un.
   *
   * `force` ignore le plancher de fréquence : après une action de
   * l'utilisateur, la pastille doit refléter ce qu'il vient de faire, pas
   * attendre quinze secondes.
   */
  async rafraichir(force = false): Promise<void> {
    const maintenant = Date.now();
    if (!force && maintenant - this.dernierAppel < INTERVALLE_MIN_MS) return;
    // Une requête déjà en vol sert tout le monde : deux navigations rapprochées
    // ne doivent pas en produire deux.
    if (this.enVol) return this.enVol;

    this.dernierAppel = maintenant;
    this.enVol = this.lire().finally(() => {
      this.enVol = null;
    });
    return this.enVol;
  }

  private async lire(): Promise<void> {
    try {
      const compteurs = await this.api.counts();
      this.compteurs.set(compteurs);

      if (compteurs.interrompt === 0) {
        this.irruption.set(null);
        return;
      }

      // On ne demande qu'UN message : la fenêtre n'en montre qu'un à la fois,
      // et les suivants reviendront au rafraîchissement d'après.
      const liste = await this.api.list({ unread: true, importance: 'critique', limit: 1 });
      this.irruption.set(premiereIrruption(liste.items));
    } catch {
      // Un échec de lecture ne casse RIEN : la pastille garde sa valeur
      // précédente, et l'écran de messagerie dira ce qui ne va pas si
      // l'utilisateur s'y rend. Faire surgir une erreur pour une pastille
      // serait disproportionné.
    }
  }

  /** Marque le message imposé comme lu, et referme la fenêtre. */
  async accuserReception(): Promise<void> {
    const message = this.irruption();
    if (!message) return;

    // La fenêtre se referme TOUT DE SUITE : le geste est sûr, et attendre
    // l'aller-retour laisserait l'utilisateur devant une fenêtre figée.
    this.irruption.set(null);
    try {
      await this.api.open(message.id);
      await this.rafraichir(true);
    } catch {
      // L'échec ne rouvre pas la fenêtre : le message reste non lu et
      // reviendra au rafraîchissement suivant. Le rouvrir sur-le-champ
      // enfermerait l'utilisateur dans une boucle qu'il ne peut pas quitter.
    }
  }

  /** Remet l'état à zéro — à la déconnexion, la boîte n'est plus la sienne. */
  oublier(): void {
    this.compteurs.set(AUCUN);
    this.irruption.set(null);
    this.dernierAppel = 0;
  }
}
