import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/api.config';
import { MessagesApi } from './messages.api';

const BASE = '/api/v1';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';

function message(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    subject: 'Bascule v2 jeudi',
    body: 'La bascule est programmée jeudi à 14h.',
    importance: 'haute',
    authorId: 'u-1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T00:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

describe('MessagesApi', () => {
  let api: MessagesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });
    api = TestBed.inject(MessagesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('lecture', () => {
    it('n’envoie AUCUN paramètre sans filtre', async () => {
      const promesse = api.list();
      const requete = http.expectOne(`${BASE}/messages`);

      expect(requete.request.params.keys()).toEqual([]);
      requete.flush({ items: [], total: 0 });
      await promesse;
    });

    it('OMET les filtres vides plutôt que de les envoyer vides', async () => {
      const promesse = api.list({ importance: '', search: undefined, limit: 10 });
      const requete = http.expectOne(r => r.url === `${BASE}/messages`);

      expect(requete.request.params.keys().sort()).toEqual(['limit']);
      requete.flush({ items: [], total: 0 });
      await promesse;
    });

    it('transmet les drapeaux comme des booléens lisibles', async () => {
      const promesse = api.list({ unread: true, archived: true });
      const requete = http.expectOne(r => r.url === `${BASE}/messages`);

      expect(requete.request.params.get('unread')).toBe('true');
      expect(requete.request.params.get('archived')).toBe('true');
      requete.flush({ items: [], total: 0 });
      await promesse;
    });

    it('envoie un décalage de 0, qui est un filtre légitime', async () => {
      const promesse = api.list({ offset: 0 });
      const requete = http.expectOne(r => r.url === `${BASE}/messages`);

      expect(requete.request.params.get('offset')).toBe('0');
      requete.flush({ items: [], total: 0 });
      await promesse;
    });

    it('valide la réponse contre le schéma partagé', async () => {
      const promesse = api.list();
      http.expectOne(`${BASE}/messages`).flush({ items: [message()], total: 1 });

      expect((await promesse).items[0]?.subject).toBe('Bascule v2 jeudi');
    });

    it('REJETTE une réponse qui dérive du schéma', async () => {
      const promesse = api.list();
      http.expectOne(`${BASE}/messages`).flush({ items: [{ id: ID }], total: 1 });

      await expect(promesse).rejects.toThrow();
    });

    it('REJETTE un message portant un champ surnuméraire', async () => {
      // Le schéma est strict : une clé de trop signale une API qui fuit — les
      // destinataires des autres comptes, par exemple.
      const promesse = api.list();
      http
        .expectOne(`${BASE}/messages`)
        .flush({ items: [{ ...message(), recipients: ['bob'] }], total: 1 });

      await expect(promesse).rejects.toThrow();
    });

    it('lit les compteurs', async () => {
      const promesse = api.counts();
      http.expectOne(`${BASE}/messages/compteurs`).flush({ total: 5, nonLus: 2, interrompt: 1 });

      expect(await promesse).toEqual({ total: 5, nonLus: 2, interrompt: 1 });
    });

    it('lit un message à l’unité', async () => {
      const promesse = api.get(ID);
      http.expectOne(`${BASE}/messages/${ID}`).flush(message());

      expect((await promesse).id).toBe(ID);
    });
  });

  describe('écriture', () => {
    it('marque lu par un POST, sans corps signifiant', async () => {
      const promesse = api.open(ID);
      const requete = http.expectOne(`${BASE}/messages/${ID}/lu`);

      expect(requete.request.method).toBe('POST');
      requete.flush(message({ readAt: '2026-01-02T00:00:00.000Z' }));

      expect((await promesse).readAt).not.toBeNull();
    });

    it('archive et désarchive par le MÊME appel', async () => {
      const archive = api.setArchived(ID, true);
      const premier = http.expectOne(`${BASE}/messages/${ID}`);
      expect(premier.request.method).toBe('PATCH');
      expect(premier.request.body).toEqual({ archived: true });
      premier.flush(message({ archivedAt: '2026-01-02T00:00:00.000Z' }));
      await archive;

      const remise = api.setArchived(ID, false);
      const second = http.expectOne(`${BASE}/messages/${ID}`);
      expect(second.request.body).toEqual({ archived: false });
      second.flush(message());
      await remise;
    });

    it('marque toute la boîte et rend les compteurs à jour', async () => {
      const promesse = api.markAllRead();
      const requete = http.expectOne(`${BASE}/messages/tout-lu`);

      expect(requete.request.method).toBe('POST');
      requete.flush({ total: 3, nonLus: 0, interrompt: 0 });

      expect((await promesse).nonLus).toBe(0);
    });
  });

  describe('envoi', () => {
    it('part en multipart, SANS Content-Type posé à la main', async () => {
      // Le navigateur doit y écrire la frontière qu'il a choisie : l'écraser
      // rendrait le corps illisible pour le serveur.
      const promesse = api.send({
        subject: 'Objet',
        body: 'Corps.',
        importance: 'normale',
        audience: 'tous',
      });
      const requete = http.expectOne(`${BASE}/messages`);

      expect(requete.request.body).toBeInstanceOf(FormData);
      expect(requete.request.headers.get('Content-Type')).toBeNull();
      requete.flush(message());
      await promesse;
    });

    it('n’envoie QUE la cible de l’audience choisie', async () => {
      const promesse = api.send({
        subject: 'Objet',
        body: 'Corps.',
        importance: 'normale',
        audience: 'tous',
      });
      const requete = http.expectOne(`${BASE}/messages`);
      const corps = requete.request.body as FormData;

      // Une cible surnuméraire ferait refuser l'envoi par le schéma, et
      // laisserait croire à une restriction qui n'existe pas.
      expect(corps.get('audience')).toBe('tous');
      expect(corps.get('audienceRank')).toBeNull();
      expect(corps.get('recipientIds')).toBeNull();
      requete.flush(message());
      await promesse;
    });

    it('joint le rang visé pour une audience de rang', async () => {
      const promesse = api.send({
        subject: 'Objet',
        body: 'Corps.',
        importance: 'normale',
        audience: 'rang',
        audienceRank: 50,
      });
      const requete = http.expectOne(`${BASE}/messages`);
      const corps = requete.request.body as FormData;

      expect(corps.get('audienceRank')).toBe('50');
      requete.flush(message());
      await promesse;
    });

    it('sérialise les comptes visés en JSON', async () => {
      // Un formulaire ne transporte que du texte, et répéter la clé produirait
      // une forme que le schéma partagé ne connaît pas.
      const promesse = api.send({
        subject: 'Objet',
        body: 'Corps.',
        importance: 'normale',
        audience: 'comptes',
        recipientIds: [ID, AUTRE],
      });
      const requete = http.expectOne(`${BASE}/messages`);
      const corps = requete.request.body as FormData;

      expect(corps.get('recipientIds')).toBe(JSON.stringify([ID, AUTRE]));
      requete.flush(message());
      await promesse;
    });

    it('joint les fichiers sous le MÊME nom de champ', async () => {
      const fichiers = [
        new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
        new File([new Uint8Array([2])], 'b.pdf', { type: 'application/pdf' }),
      ];
      const promesse = api.send(
        { subject: 'Objet', body: 'Corps.', importance: 'normale', audience: 'tous' },
        fichiers,
      );
      const requete = http.expectOne(`${BASE}/messages`);
      const corps = requete.request.body as FormData;

      expect(corps.getAll('fichiers')).toHaveLength(2);
      requete.flush(message());
      await promesse;
    });
  });

  describe('téléchargement', () => {
    it('rend une URL, pas une requête', () => {
      // Le navigateur sait déjà télécharger : lui confier l'appel conserve la
      // progression, la reprise et l'enregistrement sur le disque.
      expect(api.pieceUrl(ID)).toBe(`${BASE}/messages/pieces/${ID}`);
    });
  });
});
