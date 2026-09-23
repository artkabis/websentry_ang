import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from './helpers/app.factory.js';

const ID_ADMIN = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';
const ID_CARLA = '33333333-3333-4333-8333-333333333333';
const ID_ABSENT = '99999999-9999-4999-8999-999999999999';

const ADMIN = {
  id: ID_ADMIN,
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const BOB = { id: ID_BOB, username: 'bob', password: 'MotDePasseBob!2026', rank: RANKS.TESTER };
const CARLA = {
  id: ID_CARLA,
  username: 'carla',
  password: 'MotDePasseCarla!2026',
  rank: RANKS.EDITOR,
};

/** Un PNG minimal — seule l'empreinte compte. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2a]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

describe('Messagerie in-app (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([ADMIN, BOB, CARLA]);
    http = request(t.app.getHttpServer());
  });

  afterEach(async () => {
    await t.close();
  });

  async function session(user: { username: string; password: string }) {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: user.username, password: user.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies, csrf: cookieValue(cookies, COOKIES.CSRF)! };
  }

  function write(
    method: 'post' | 'patch',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  /** Compose un envoi multipart, pièces jointes comprises. */
  function envoi(
    auth: { cookies: string[]; csrf: string },
    champs: Record<string, string> = {},
    fichiers: { nom: string; octets: Buffer }[] = [],
  ) {
    const requete = write('post', '/messages', auth)
      .field('subject', champs['subject'] ?? 'Bascule v2 jeudi')
      .field('body', champs['body'] ?? 'La bascule est programmée jeudi à 14h.')
      .field('audience', champs['audience'] ?? 'tous');

    for (const [cle, valeur] of Object.entries(champs)) {
      if (!['subject', 'body', 'audience'].includes(cle)) requete.field(cle, valeur);
    }
    for (const fichier of fichiers) {
      requete.attach('fichiers', fichier.octets, fichier.nom);
    }
    return requete;
  }

  describe('accès', () => {
    it('refuse un anonyme', async () => {
      await http.get(t.url('/messages')).expect(401);
      await http.post(t.url('/messages')).expect(401);
    });

    it('OUVRE la boîte à tout compte authentifié', async () => {
      // Une permission de lecture ici fermerait la boîte à ceux-là mêmes à qui
      // l'on écrit.
      const bob = await session(BOB);
      const res = await http.get(t.url('/messages')).set('Cookie', bob.cookies).expect(200);

      expect(res.body).toEqual({ items: [], total: 0 });
    });

    it('REFUSE la composition à qui n’a pas messages:write', async () => {
      const bob = await session(BOB);
      await envoi(bob).expect(403);
    });

    it('OUVRE la composition à qui détient messages:write', async () => {
      const admin = await session(ADMIN);
      const res = await envoi(admin).expect(201);

      expect(res.body).toMatchObject({ subject: 'Bascule v2 jeudi', authorName: 'admin' });
    });

    it('accorde messages:write à un rang inférieur par permission EXPLICITE', async () => {
      // Le sens de circulation est porté par la permission, pas par le rang.
      t.db.permissions.set(ID_BOB, [{ permission: PERMISSIONS.MESSAGES_WRITE, gammes: null }]);
      const bob = await session(BOB);

      await envoi(bob).expect(201);
    });

    it('refuse une écriture sans jeton CSRF', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/messages'))
        .set('Cookie', admin.cookies)
        .field('subject', 'Bascule')
        .field('body', 'Jeudi.')
        .field('audience', 'tous')
        .expect(403);
    });
  });

  describe('audience', () => {
    it('touche TOUS les comptes actifs', async () => {
      const admin = await session(ADMIN);
      await envoi(admin).expect(201);

      for (const compte of [ADMIN, BOB, CARLA]) {
        const auth = await session(compte);
        const res = await http.get(t.url('/messages')).set('Cookie', auth.cookies).expect(200);
        expect(res.body.total).toBe(1);
      }
    });

    it('EXCLUT un compte suspendu', async () => {
      // Lui écrire reviendrait à garnir une boîte que personne n'ouvrira.
      const compte = t.db.users.get(ID_BOB)!;
      compte.status = 'suspended';

      const admin = await session(ADMIN);
      await envoi(admin).expect(201);

      expect([...t.db.messageRecipients.values()].map(d => d.user_id)).not.toContain(ID_BOB);
    });

    it('restreint par RANG quand l’audience le demande', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { audience: 'rang', audienceRank: '30' }).expect(201);

      const destinataires = [...t.db.messageRecipients.values()].map(d => d.user_id);
      expect(destinataires).toContain(ID_CARLA);
      expect(destinataires).toContain(ID_ADMIN);
      expect(destinataires).not.toContain(ID_BOB);
    });

    it('vise des comptes NOMMÉS, et ajoute l’auteur', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, {
        audience: 'comptes',
        recipientIds: JSON.stringify([ID_BOB]),
      }).expect(201);

      const destinataires = [...t.db.messageRecipients.values()].map(d => d.user_id);
      expect(destinataires.sort()).toEqual([ID_ADMIN, ID_BOB].sort());
    });

    it('REFUSE un envoi dont l’audience ne désigne personne', async () => {
      // Écrire à personne réussirait en silence, et l'auteur croirait avoir
      // prévenu quelqu'un.
      const admin = await session(ADMIN);
      await envoi(admin, {
        audience: 'comptes',
        recipientIds: JSON.stringify([ID_ABSENT]),
      }).expect(404);

      expect(t.db.messages.size).toBe(0);
    });

    it('EXIGE la cible que l’audience annonce', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { audience: 'rang' }).expect(400);
      await envoi(admin, { audience: 'comptes' }).expect(400);
    });
  });

  describe('état de lecture', () => {
    it('arrive NON LU, et le compteur le dit', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { importance: 'critique' }).expect(201);

      const bob = await session(BOB);
      const res = await http
        .get(t.url('/messages/compteurs'))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(res.body).toEqual({ total: 1, nonLus: 1, interrompt: 1 });
    });

    it('l’auteur reçoit sa copie DÉJÀ LUE', async () => {
      // Sans copie il ne pourrait pas se relire ; sans marquage, sa propre
      // annonce critique l'interromprait.
      const admin = await session(ADMIN);
      await envoi(admin, { importance: 'critique' }).expect(201);

      const res = await http
        .get(t.url('/messages/compteurs'))
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(res.body).toEqual({ total: 1, nonLus: 0, interrompt: 0 });
    });

    it('OUVRIR vaut lecture, sans geste supplémentaire', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);

      const bob = await session(BOB);
      const ouvert = await write('post', `/messages/${body.id}/lu`, bob).expect(201);

      expect(ouvert.body.readAt).not.toBeNull();
    });

    it('ne REPOUSSE PAS la date de première lecture', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);
      const bob = await session(BOB);

      const premiere = await write('post', `/messages/${body.id}/lu`, bob).expect(201);
      const seconde = await write('post', `/messages/${body.id}/lu`, bob).expect(201);

      expect(seconde.body.readAt).toBe(premiere.body.readAt);
    });

    it('marque TOUTE la boîte d’un geste', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { subject: 'Premier message' }).expect(201);
      await envoi(admin, { subject: 'Second message' }).expect(201);

      const bob = await session(BOB);
      const res = await write('post', '/messages/tout-lu', bob).expect(201);

      expect(res.body).toEqual({ total: 2, nonLus: 0, interrompt: 0 });
    });
  });

  describe('archivage', () => {
    it('RETIRE de la vue par défaut, sans supprimer', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);
      const bob = await session(BOB);

      await write('patch', `/messages/${body.id}`, bob).send({ archived: true }).expect(200);

      const boite = await http.get(t.url('/messages')).set('Cookie', bob.cookies).expect(200);
      expect(boite.body.total).toBe(0);

      const archives = await http
        .get(t.url('/messages?archived=true'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(archives.body.total).toBe(1);
    });

    it('reste LISIBLE à l’unité une fois archivé', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);
      const bob = await session(BOB);

      await write('patch', `/messages/${body.id}`, bob).send({ archived: true }).expect(200);
      await http
        .get(t.url(`/messages/${body.id}`))
        .set('Cookie', bob.cookies)
        .expect(200);
    });

    it('se DÉSARCHIVE par le même geste', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);
      const bob = await session(BOB);

      await write('patch', `/messages/${body.id}`, bob).send({ archived: true }).expect(200);
      const rendu = await write('patch', `/messages/${body.id}`, bob)
        .send({ archived: false })
        .expect(200);

      expect(rendu.body.archivedAt).toBeNull();
    });

    it('n’affecte QUE la boîte de celui qui archive', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);
      const bob = await session(BOB);
      await write('patch', `/messages/${body.id}`, bob).send({ archived: true }).expect(200);

      const carla = await session(CARLA);
      const res = await http.get(t.url('/messages')).set('Cookie', carla.cookies).expect(200);
      expect(res.body.total).toBe(1);
    });
  });

  describe('filtres et pagination', () => {
    beforeEach(async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { subject: 'Consigne de bascule', importance: 'critique' }).expect(201);
      await envoi(admin, { subject: 'Note de version', importance: 'normale' }).expect(201);
    });

    it('filtre sur les NON LUS', async () => {
      const bob = await session(BOB);
      const tout = await http.get(t.url('/messages')).set('Cookie', bob.cookies).expect(200);
      const premier = tout.body.items[0].id as string;
      await write('post', `/messages/${premier}/lu`, bob).expect(201);

      const res = await http
        .get(t.url('/messages?unread=true'))
        .set('Cookie', bob.cookies)
        .expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].id).not.toBe(premier);
    });

    it('filtre sur l’IMPORTANCE', async () => {
      const bob = await session(BOB);
      const res = await http
        .get(t.url('/messages?importance=critique'))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0].subject).toBe('Consigne de bascule');
    });

    it('cherche dans le sujet ET le corps', async () => {
      const bob = await session(BOB);
      const res = await http
        .get(t.url('/messages?search=version'))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(res.body.total).toBe(1);
    });

    it('annonce le total AVANT pagination', async () => {
      // Sans lui, l'interface ne sait pas combien de pages elle doit offrir.
      const bob = await session(BOB);
      const res = await http
        .get(t.url('/messages?limit=1&offset=0'))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(2);
    });
  });

  describe('pièces jointes', () => {
    it('accepte une image et la rend téléchargeable au destinataire', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin, {}, [{ nom: 'capture.png', octets: PNG }]).expect(201);

      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({ nom: 'capture.png', mime: 'image/png' });

      const bob = await session(BOB);
      const fichier = await http
        .get(t.url(`/messages/pieces/${body.attachments[0].id}`))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(Buffer.compare(fichier.body as Buffer, PNG)).toBe(0);
      expect(fichier.headers['content-disposition']).toContain('attachment;');
      expect(fichier.headers['x-content-type-options']).toBe('nosniff');
    });

    it('REFUSE un exécutable déguisé en image', async () => {
      // Le type est lu dans le fichier : l'extension est une déclaration de
      // l'appelant.
      const admin = await session(ADMIN);
      await envoi(admin, {}, [{ nom: 'capture.png', octets: EXE }]).expect(400);

      expect(t.db.messages.size).toBe(0);
      expect(t.db.messageAttachments.size).toBe(0);
    });

    it('CONSERVE le nom d’origine pour l’affichage', async () => {
      // Le nom sert à reconnaître la pièce, jamais à la ranger : le fichier est
      // écrit sous un identifiant généré. Le cas du nom porteur de chemin est
      // vérifié dans `owasp-messagerie`, où la requête est forgée à la main —
      // Supertest, lui, réduit le nom à sa base avant de l'envoyer.
      const admin = await session(ADMIN);
      const { body } = await envoi(admin, {}, [{ nom: 'capture écran.png', octets: PNG }]).expect(
        201,
      );

      expect(body.attachments[0].nom).toBe('capture écran.png');
    });

    it('REFUSE une quatrième pièce jointe', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, {}, [
        { nom: '1.png', octets: PNG },
        { nom: '2.png', octets: PNG },
        { nom: '3.png', octets: PNG },
        { nom: '4.png', octets: PNG },
      ]).expect(400);
    });

    it('rend 404 sur la pièce jointe d’un message qu’on ne reçoit PAS', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(
        admin,
        { audience: 'comptes', recipientIds: JSON.stringify([ID_BOB]) },
        [{ nom: 'capture.png', octets: PNG }],
      ).expect(201);

      const carla = await session(CARLA);
      await http
        .get(t.url(`/messages/pieces/${body.attachments[0].id}`))
        .set('Cookie', carla.cookies)
        .expect(404);
    });
  });

  describe('cloisonnement', () => {
    it('rend 404 sur un message adressé à quelqu’un d’autre', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin, {
        audience: 'comptes',
        recipientIds: JSON.stringify([ID_BOB]),
      }).expect(201);

      const carla = await session(CARLA);
      await http
        .get(t.url(`/messages/${body.id}`))
        .set('Cookie', carla.cookies)
        .expect(404);
    });

    it('n’offre NI suppression NI réécriture', async () => {
      const admin = await session(ADMIN);
      const { body } = await envoi(admin).expect(201);

      await write('post', `/messages/${body.id}`, admin).expect(404);
      await http
        .delete(t.url(`/messages/${body.id}`))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf)
        .expect(404);
    });

    it('JOURNALISE l’envoi sans recopier le corps', async () => {
      const admin = await session(ADMIN);
      await envoi(admin, { body: 'Information strictement confidentielle.' }).expect(201);

      const trace = t.db.auditLog.find(e => e['action'] === 'message.send');
      expect(trace).toBeDefined();
      expect(JSON.stringify(trace)).not.toContain('confidentielle');
    });
  });
});
