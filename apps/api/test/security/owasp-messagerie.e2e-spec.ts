import { PERMISSIONS, RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import { cookieValue, createTestApp, type TestApp } from '../helpers/app.factory.js';

/**
 * Suite sécurité — module 8 (messagerie in-app).
 *
 * C'est le PREMIER module qui accepte un fichier. La faille n°14 du cahier des
 * charges le nommait explicitement : « path traversal / upload de fichiers non
 * validés (pièces jointes messagerie) ». Elle est donc traitée ici avec des
 * requêtes FORGÉES À LA MAIN — un client HTTP normal nettoie le nom de fichier
 * avant de l'envoyer, et une suite qui s'appuierait sur lui vérifierait la
 * politesse du client, pas la défense du serveur.
 */

const ID_ADMIN = '11111111-1111-4111-8111-111111111111';
const ID_BOB = '22222222-2222-4222-8222-222222222222';
const ID_CARLA = '33333333-3333-4333-8333-333333333333';

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2a]);
const FRONTIERE = '----WebSentryFrontiereDeTest';

type Partie =
  | { champ: string; valeur: string }
  | { champ: string; fichier: string; octets: Buffer; type?: string };

/**
 * Corps `multipart/form-data` construit OCTET PAR OCTET.
 *
 * C'est le seul moyen de faire passer un nom de fichier que ni un navigateur
 * ni Supertest n'accepteraient de transmettre tel quel.
 */
function corpsMultipart(parties: readonly Partie[]): Buffer {
  const morceaux: Buffer[] = [];
  for (const partie of parties) {
    morceaux.push(Buffer.from(`--${FRONTIERE}\r\n`));
    if ('valeur' in partie) {
      morceaux.push(
        Buffer.from(`Content-Disposition: form-data; name="${partie.champ}"\r\n\r\n`),
        Buffer.from(partie.valeur),
        Buffer.from('\r\n'),
      );
      continue;
    }
    morceaux.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${partie.champ}"; filename="${partie.fichier}"\r\n` +
          `Content-Type: ${partie.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      partie.octets,
      Buffer.from('\r\n'),
    );
  }
  morceaux.push(Buffer.from(`--${FRONTIERE}--\r\n`));
  return Buffer.concat(morceaux);
}

describe('Suite sécurité OWASP — module 8 (E2E)', () => {
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
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    auth: { cookies: string[]; csrf: string },
  ) {
    return http[method](t.url(path)).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrf);
  }

  /** Envoi brut — les parties sont écrites telles quelles. */
  function envoiBrut(auth: { cookies: string[]; csrf: string }, parties: readonly Partie[]) {
    return write('post', '/messages', auth)
      .set('Content-Type', `multipart/form-data; boundary=${FRONTIERE}`)
      .send(corpsMultipart(parties));
  }

  const CHAMPS: Partie[] = [
    { champ: 'subject', valeur: 'Bascule v2 jeudi' },
    { champ: 'body', valeur: 'La bascule est programmée jeudi à 14h.' },
    { champ: 'audience', valeur: 'tous' },
  ];

  /** Envoie un message et rend sa vue. */
  async function envoyer(
    auth: { cookies: string[]; csrf: string },
    parties: readonly Partie[] = [],
  ) {
    const res = await envoiBrut(auth, [...CHAMPS, ...parties]).expect(201);
    return res.body as { id: string; attachments: { id: string; nom: string }[] };
  }

  // ── 1. Injection SQL ──────────────────────────────────────────────────────

  describe('1. Injection SQL', () => {
    it.each([
      "' OR '1'='1",
      "'; DROP TABLE messages; --",
      "' UNION SELECT id, password_hash FROM users --",
      "'; UPDATE message_recipients SET read_at = NOW() WHERE 1=1; --",
    ])('laisse la boîte INTACTE après « %s »', async charge => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin);
      const bob = await session(BOB);

      await http
        .get(t.url(`/messages?search=${encodeURIComponent(charge)}`))
        .set('Cookie', bob.cookies)
        .expect(200);

      // La charge visait la table et l'état de lecture : ni l'une ni l'autre
      // ne bouge. On nomme LA ligne attendue plutôt qu'une propriété globale
      // qu'une copie déjà lue rendrait vraie toute seule.
      expect(t.db.messages.size).toBe(1);
      expect(t.db.messageRecipients.get(`${message.id}:${ID_BOB}`)?.read_at).toBeNull();
      expect(t.db.users.size).toBe(3);
    });

    it('REFUSE une importance hors catalogue plutôt que de l’interpoler', async () => {
      const bob = await session(BOB);
      await http
        .get(t.url("/messages?importance=critique' OR 1=1 --"))
        .set('Cookie', bob.cookies)
        .expect(400);
    });

    it('REFUSE une audience et un rang hors catalogue', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Test' },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: "tous'; DROP TABLE messages; --" },
      ]).expect(400);

      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Test' },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: 'rang' },
        { champ: 'audienceRank', valeur: '42' },
      ]).expect(400);
    });
  });

  // ── 14. Traversée de chemin et fichiers non validés ───────────────────────

  describe('14. Traversée de chemin et fichiers non validés', () => {
    it.each([
      '../../../etc/passwd.png',
      '..\\..\\windows\\system32\\cmd.png',
      '/etc/cron.d/porte.png',
      '....//....//etc/passwd.png',
    ])('ne laisse PAS « %s » désigner un chemin', async nom => {
      // Le fichier est rangé sous un identifiant généré : il n'y a aucun chemin
      // à filtrer, donc rien à contourner. Le nom d'origine survit nettoyé,
      // pour l'affichage seulement.
      const admin = await session(ADMIN);
      const message = await envoyer(admin, [
        { champ: 'fichiers', fichier: nom, octets: PNG, type: 'image/png' },
      ]);

      const piece = message.attachments[0]!;
      expect(piece.nom).not.toContain('/');
      expect(piece.nom).not.toContain('\\');
      expect(piece.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('NEUTRALISE un octet nul dans le nom', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin, [
        { champ: 'fichiers', fichier: 'rapport\u0000.png', octets: PNG },
      ]);

      expect(message.attachments[0]!.nom).not.toContain('\u0000');
    });

    it('REFUSE un script déguisé en image, `Content-Type` menteur compris', async () => {
      // Extension ET en-tête annoncent une image ; les octets disent autre
      // chose, et ce sont les octets qui décident.
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        ...CHAMPS,
        {
          champ: 'fichiers',
          fichier: 'capture.png',
          octets: Buffer.from('<?php system($_GET["c"]); ?>'),
          type: 'image/png',
        },
      ]).expect(400);

      expect(t.db.messageAttachments.size).toBe(0);
    });

    it('REFUSE un SVG, même bien formé', async () => {
      // Un SVG est un document exécutable : il n'a pas sa place dans une liste
      // blanche d'images.
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        ...CHAMPS,
        {
          champ: 'fichiers',
          fichier: 'logo.svg',
          octets: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ),
          type: 'image/svg+xml',
        },
      ]).expect(400);
    });

    it('REFUSE une archive et un exécutable', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        ...CHAMPS,
        { champ: 'fichiers', fichier: 'outil.zip', octets: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
      ]).expect(400);

      await envoiBrut(admin, [
        ...CHAMPS,
        { champ: 'fichiers', fichier: 'outil.exe', octets: Buffer.from([0x4d, 0x5a, 0x90]) },
      ]).expect(400);
    });

    it('n’écrit RIEN quand une pièce du lot est refusée', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        ...CHAMPS,
        { champ: 'fichiers', fichier: 'bon.png', octets: PNG },
        { champ: 'fichiers', fichier: 'mauvais.png', octets: Buffer.from([0x4d, 0x5a]) },
      ]).expect(400);

      expect(t.db.messages.size).toBe(0);
      expect(t.db.messageAttachments.size).toBe(0);
    });

    it('REFUSE — en 400, jamais en 500 — au-delà du nombre de pièces', async () => {
      // La limite du plugin de transport ne doit pas remonter comme une panne
      // du serveur : c'est une erreur de l'appelant.
      const admin = await session(ADMIN);
      const res = await envoiBrut(admin, [
        ...CHAMPS,
        { champ: 'fichiers', fichier: '1.png', octets: PNG },
        { champ: 'fichiers', fichier: '2.png', octets: PNG },
        { champ: 'fichiers', fichier: '3.png', octets: PNG },
        { champ: 'fichiers', fichier: '4.png', octets: PNG },
      ]);

      expect(res.status).toBe(400);
    });

    it('REFUSE — en 400 — une pièce au-delà du plafond de taille', async () => {
      const admin = await session(ADMIN);
      const trop = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
      const res = await envoiBrut(admin, [
        ...CHAMPS,
        { champ: 'fichiers', fichier: 'gros.png', octets: trop },
      ]);

      expect(res.status).toBe(400);
      expect(t.db.messageAttachments.size).toBe(0);
    });

    it('ne sert AUCUN fichier par un chemin', async () => {
      // Il n'existe pas de route de fichiers statiques : une pièce jointe se
      // demande par son identifiant, et par rien d'autre.
      const bob = await session(BOB);
      for (const chemin of ['../../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'nul%00.png']) {
        const res = await http.get(t.url(`/messages/pieces/${chemin}`)).set('Cookie', bob.cookies);

        expect([400, 404]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toContain('root:');
      }
    });
  });

  // ── 5. Contrôle d'accès ───────────────────────────────────────────────────

  describe('5. Contrôle d’accès défaillant', () => {
    it('FERME par défaut : aucune route de messagerie n’est publique', async () => {
      await http.get(t.url('/messages')).expect(401);
      await http.get(t.url('/messages/compteurs')).expect(401);
      await http.post(t.url('/messages')).expect(401);
      await http.get(t.url(`/messages/pieces/${ID_ADMIN}`)).expect(401);
    });

    it('REFUSE la composition sans messages:write', async () => {
      const bob = await session(BOB);
      await envoiBrut(bob, CHAMPS).expect(403);
      expect(t.db.messages.size).toBe(0);
    });

    it('IDOR : le message d’autrui rend 404, INDISCERNABLE d’un message absent', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin, []);
      // Ciblé sur Bob seulement.
      const cible = await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Pour Bob seulement' },
        { champ: 'body', valeur: 'Confidentiel.' },
        { champ: 'audience', valeur: 'comptes' },
        { champ: 'recipientIds', valeur: JSON.stringify([ID_BOB]) },
      ]).expect(201);

      const carla = await session(CARLA);
      const autrui = await http
        .get(t.url(`/messages/${cible.body.id}`))
        .set('Cookie', carla.cookies);
      const absent = await http
        .get(t.url('/messages/99999999-9999-4999-8999-999999999999'))
        .set('Cookie', carla.cookies);

      expect(autrui.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(autrui.body.message).toBe(absent.body.message);
      // Le message « à tous », lui, reste lisible : la garde cloisonne, elle
      // ne ferme pas tout.
      await http
        .get(t.url(`/messages/${message.id}`))
        .set('Cookie', carla.cookies)
        .expect(200);
    });

    it('ne laisse PAS marquer lu le message d’autrui', async () => {
      const admin = await session(ADMIN);
      const cible = await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Pour Bob' },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: 'comptes' },
        { champ: 'recipientIds', valeur: JSON.stringify([ID_BOB]) },
      ]).expect(201);

      const carla = await session(CARLA);
      await write('post', `/messages/${cible.body.id}/lu`, carla).expect(404);
      await write('patch', `/messages/${cible.body.id}`, carla)
        .send({ archived: true })
        .expect(404);

      expect(t.db.messageRecipients.get(`${cible.body.id}:${ID_BOB}`)?.read_at).toBeNull();
    });

    it('n’expose NI suppression NI réécriture d’un message', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin);

      for (const methode of ['put', 'delete'] as const) {
        await write(methode, `/messages/${message.id}`, admin).expect(404);
      }
      expect(t.db.messages.size).toBe(1);
    });

    it('ne sert PAS la pièce jointe d’un message qu’on ne reçoit pas', async () => {
      const admin = await session(ADMIN);
      const cible = await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Pour Bob' },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: 'comptes' },
        { champ: 'recipientIds', valeur: JSON.stringify([ID_BOB]) },
        { champ: 'fichiers', fichier: 'capture.png', octets: PNG },
      ]).expect(201);

      const idPiece = (cible.body as { attachments: { id: string }[] }).attachments[0]!.id;
      const carla = await session(CARLA);
      const refus = await http
        .get(t.url(`/messages/pieces/${idPiece}`))
        .set('Cookie', carla.cookies);
      const inconnue = await http
        .get(t.url('/messages/pieces/99999999-9999-4999-8999-999999999999'))
        .set('Cookie', carla.cookies);

      expect(refus.status).toBe(404);
      expect(refus.body.message).toBe(inconnue.body.message);
    });
  });

  // ── 3. CSRF ───────────────────────────────────────────────────────────────

  describe('3. CSRF', () => {
    it('refuse toute écriture par cookie sans jeton', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin);

      await http
        .post(t.url('/messages'))
        .set('Cookie', admin.cookies)
        .set('Content-Type', `multipart/form-data; boundary=${FRONTIERE}`)
        .send(corpsMultipart(CHAMPS))
        .expect(403);
      await http
        .post(t.url(`/messages/${message.id}/lu`))
        .set('Cookie', admin.cookies)
        .expect(403);
      await http.post(t.url('/messages/tout-lu')).set('Cookie', admin.cookies).expect(403);
    });

    it('refuse un jeton DIVERGENT du cookie', async () => {
      const admin = await session(ADMIN);
      await http
        .post(t.url('/messages'))
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', 'jeton-fabrique')
        .set('Content-Type', `multipart/form-data; boundary=${FRONTIERE}`)
        .send(corpsMultipart(CHAMPS))
        .expect(403);
    });
  });

  // ── 15. Mass assignment ───────────────────────────────────────────────────

  describe('15. Mass assignment et validation d’entrée', () => {
    it.each(['authorId', 'authorName', 'sentAt', 'readAt', 'id', 'attachments'])(
      'REJETTE la clé surnuméraire %s',
      async cle => {
        const admin = await session(ADMIN);
        await envoiBrut(admin, [...CHAMPS, { champ: cle, valeur: 'x' }]).expect(400);

        expect(t.db.messages.size).toBe(0);
      },
    );

    it('n’expose AUCUN champ hors du contrat de lecture', async () => {
      const admin = await session(ADMIN);
      await envoyer(admin);
      const bob = await session(BOB);

      const res = await http.get(t.url('/messages')).set('Cookie', bob.cookies).expect(200);
      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        [
          'archivedAt',
          'attachments',
          'authorId',
          'authorName',
          'body',
          'id',
          'importance',
          'readAt',
          'sentAt',
          'subject',
        ].sort(),
      );
      // L'audience et les autres destinataires ne regardent pas celui qui lit.
      expect(res.body.items[0]).not.toHaveProperty('audience');
      expect(res.body.items[0]).not.toHaveProperty('recipients');
    });

    it('BORNE la pagination et refuse un paramètre inconnu', async () => {
      const bob = await session(BOB);
      await http.get(t.url('/messages?limit=1000')).set('Cookie', bob.cookies).expect(400);
      await http.get(t.url('/messages?offset=-1')).set('Cookie', bob.cookies).expect(400);
      await http.get(t.url('/messages?userId=autre')).set('Cookie', bob.cookies).expect(400);
    });

    it('BORNE le sujet et le corps', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'a'.repeat(151) },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: 'tous' },
      ]).expect(400);

      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Un sujet' },
        { champ: 'body', valeur: 'a'.repeat(10_001) },
        { champ: 'audience', valeur: 'tous' },
      ]).expect(400);
    });

    it('REFUSE un `recipientIds` qui n’est pas un tableau d’identifiants', async () => {
      const admin = await session(ADMIN);
      for (const valeur of ['[u-1, u-2', '"pas-un-tableau"', '["pas-un-uuid"]', '{}']) {
        await envoiBrut(admin, [
          { champ: 'subject', valeur: 'Un sujet' },
          { champ: 'body', valeur: 'Corps.' },
          { champ: 'audience', valeur: 'comptes' },
          { champ: 'recipientIds', valeur },
        ]).expect(400);
      }
    });

    it('REFUSE un envoi qui n’est pas du multipart', async () => {
      const admin = await session(ADMIN);
      await write('post', '/messages', admin)
        .send({ subject: 'Un sujet', body: 'Corps.', audience: 'tous' })
        .expect(400);
    });
  });

  // ── 9. Pollution de prototype ─────────────────────────────────────────────

  describe('9. Pollution de prototype', () => {
    it.each(['__proto__', 'constructor', 'prototype'])(
      'NEUTRALISE la clé %s soumise au formulaire',
      async cle => {
        const admin = await session(ADMIN);
        await envoiBrut(admin, [...CHAMPS, { champ: cle, valeur: '{"pollue":true}' }]);

        expect(({} as Record<string, unknown>)['pollue']).toBeUndefined();
      },
    );

    it('NEUTRALISE une clé dangereuse dans `recipientIds`', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Un sujet' },
        { champ: 'body', valeur: 'Corps.' },
        { champ: 'audience', valeur: 'comptes' },
        { champ: 'recipientIds', valeur: '{"__proto__":{"pollue":true}}' },
      ]);

      expect(({} as Record<string, unknown>)['pollue']).toBeUndefined();
    });
  });

  // ── 2. XSS ────────────────────────────────────────────────────────────────

  describe('2. XSS stocké', () => {
    it('restitue une charge HTML en JSON NON interprétable', async () => {
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        { champ: 'subject', valeur: '<script>alert(1)</script>' },
        { champ: 'body', valeur: '<img src=x onerror=alert(1)>' },
        { champ: 'audience', valeur: 'tous' },
      ]).expect(201);

      const bob = await session(BOB);
      const res = await http.get(t.url('/messages')).set('Cookie', bob.cookies).expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.items[0].subject).toBe('<script>alert(1)</script>');
    });

    it('sert une pièce jointe en TÉLÉCHARGEMENT, jamais en affichage', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin, [
        { champ: 'fichiers', fichier: 'capture.png', octets: PNG },
      ]);

      const bob = await session(BOB);
      const fichier = await http
        .get(t.url(`/messages/pieces/${message.attachments[0]!.id}`))
        .set('Cookie', bob.cookies)
        .expect(200);

      expect(fichier.headers['content-disposition']).toContain('attachment;');
      expect(fichier.headers['x-content-type-options']).toBe('nosniff');
      expect(fichier.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  // ── 7. Données sensibles et messages d'erreur ─────────────────────────────

  describe('7. Données sensibles et messages d’erreur', () => {
    it('n’expose JAMAIS le chemin de stockage d’une pièce jointe', async () => {
      const admin = await session(ADMIN);
      const message = await envoyer(admin, [
        { champ: 'fichiers', fichier: 'capture.png', octets: PNG },
      ]);

      const corps = JSON.stringify(message);
      expect(corps).not.toContain('/tmp');
      expect(corps).not.toContain('pieces-jointes');
      expect(Object.keys(message.attachments[0]!).sort()).toEqual(['id', 'mime', 'nom', 'taille']);
    });

    it('rend une erreur UNIFORME, sans trace d’exécution', async () => {
      const bob = await session(BOB);
      const res = await http.get(t.url('/messages/pas-un-uuid')).set('Cookie', bob.cookies);

      expect([400, 404]).toContain(res.status);
      expect(res.body).toHaveProperty('requestId');
      expect(JSON.stringify(res.body)).not.toContain('at ');
      expect(JSON.stringify(res.body)).not.toContain('node_modules');
    });

    it('ne recopie PAS le corps du message dans le journal d’audit', async () => {
      // Le journal dit qui a écrit à qui ; il n'archive pas la correspondance.
      const admin = await session(ADMIN);
      await envoiBrut(admin, [
        { champ: 'subject', valeur: 'Consigne' },
        { champ: 'body', valeur: 'Mot de passe temporaire : Tr0ub4dor&3' },
        { champ: 'audience', valeur: 'tous' },
      ]).expect(201);

      const trace = t.db.auditLog.find(e => e['action'] === 'message.send');
      expect(trace).toBeDefined();
      expect(JSON.stringify(trace)).not.toContain('Tr0ub4dor');
    });
  });

  // ── 12. Limitation de débit ───────────────────────────────────────────────

  describe('12. Limitation de débit', () => {
    it('PLAFONNE l’envoi — un message touche toute une population', async () => {
      const admin = await session(ADMIN);

      let refuse = false;
      for (let i = 0; i < 12 && !refuse; i += 1) {
        const res = await envoiBrut(admin, [
          { champ: 'subject', valeur: `Envoi numéro ${i}` },
          { champ: 'body', valeur: 'Corps du message.' },
          { champ: 'audience', valeur: 'tous' },
        ]);
        refuse = res.status === 429;
      }

      expect(refuse).toBe(true);
    });
  });

  // ── Permission explicite ──────────────────────────────────────────────────

  describe('permission, pas rang', () => {
    it('ouvre la composition à un rang INFÉRIEUR qui porte messages:write', async () => {
      // La garde repose sur la permission : elle reste accordable à un compte
      // de rang inférieur, exactement comme dans la v1.
      t.db.permissions.set(ID_CARLA, [{ permission: PERMISSIONS.MESSAGES_WRITE, gammes: null }]);
      const carla = await session(CARLA);

      await envoiBrut(carla, CHAMPS).expect(201);
    });
  });
});
