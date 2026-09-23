import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  MessageCountsSchema,
  MessageListResponseSchema,
  MessageSchema,
  type CreateMessageInput,
  type Message,
  type MessageCounts,
  type MessageListResponse,
} from '@websentry/shared';
import { API_BASE_URL } from '../api/api.config';

/** Filtres de lecture, tels que l'interface les manipule — tout est facultatif. */
export interface MessageFilters {
  unread?: boolean;
  importance?: string;
  search?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Client HTTP de la messagerie.
 *
 * Aucune méthode de suppression ni de réécriture : l'API n'en expose pas, et un
 * client qui en offrirait donnerait une fausse idée de ce que l'outil garantit
 * au destinataire d'un message.
 *
 * L'envoi passe par `FormData` parce que la route attend du
 * `multipart/form-data` — c'est la seule façon d'y joindre un fichier. Le
 * `Content-Type` n'est jamais posé à la main : le navigateur doit y écrire la
 * frontière qu'il a lui-même choisie, et l'écraser rendrait le corps illisible.
 */
@Injectable({ providedIn: 'root' })
export class MessagesApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private toParams(filtres: MessageFilters): HttpParams {
    let params = new HttpParams();
    for (const [cle, valeur] of Object.entries(filtres)) {
      // Les valeurs vides sont OMISES : le schéma du backend est strict, et un
      // `importance=` vide n'exprime aucun filtre.
      if (valeur === undefined || valeur === null || valeur === '') continue;
      params = params.set(cle, String(valeur));
    }
    return params;
  }

  async list(filtres: MessageFilters = {}): Promise<MessageListResponse> {
    const brut = await firstValueFrom(
      this.http.get<unknown>(`${this.baseUrl}/messages`, { params: this.toParams(filtres) }),
    );
    return MessageListResponseSchema.parse(brut);
  }

  async counts(): Promise<MessageCounts> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/messages/compteurs`));
    return MessageCountsSchema.parse(brut);
  }

  async get(id: string): Promise<Message> {
    const brut = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/messages/${id}`));
    return MessageSchema.parse(brut);
  }

  /** Ouvrir vaut lecture : l'API marque, et rend le message à jour. */
  async open(id: string): Promise<Message> {
    const brut = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/messages/${id}/lu`, {}),
    );
    return MessageSchema.parse(brut);
  }

  async setArchived(id: string, archived: boolean): Promise<Message> {
    const brut = await firstValueFrom(
      this.http.patch<unknown>(`${this.baseUrl}/messages/${id}`, { archived }),
    );
    return MessageSchema.parse(brut);
  }

  async markAllRead(): Promise<MessageCounts> {
    const brut = await firstValueFrom(
      this.http.post<unknown>(`${this.baseUrl}/messages/tout-lu`, {}),
    );
    return MessageCountsSchema.parse(brut);
  }

  /**
   * Envoie un message, avec ses éventuelles pièces jointes.
   *
   * `recipientIds` part en JSON : un formulaire ne transporte que du texte, et
   * répéter la clé produirait une forme que le schéma partagé ne connaît pas.
   */
  async send(entree: CreateMessageInput, fichiers: readonly File[] = []): Promise<Message> {
    const corps = new FormData();
    corps.set('subject', entree.subject);
    corps.set('body', entree.body);
    corps.set('importance', entree.importance);
    corps.set('audience', entree.audience);
    if (entree.audience === 'rang') corps.set('audienceRank', String(entree.audienceRank));
    if (entree.audience === 'comptes') {
      corps.set('recipientIds', JSON.stringify(entree.recipientIds));
    }
    for (const fichier of fichiers) corps.append('fichiers', fichier, fichier.name);

    const brut = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/messages`, corps));
    return MessageSchema.parse(brut);
  }

  /**
   * Adresse de téléchargement d'une pièce jointe.
   *
   * Une URL et non un appel : le navigateur sait déjà télécharger, et lui
   * confier la requête conserve la barre de progression, la reprise et
   * l'enregistrement direct sur le disque — que reconstruire depuis un blob
   * ferait perdre.
   */
  pieceUrl(id: string): string {
    return `${this.baseUrl}/messages/pieces/${id}`;
  }
}
