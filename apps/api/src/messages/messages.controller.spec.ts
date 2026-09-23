import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, RANKS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { MessagesController } from './messages.controller.js';
import type { MessagesService } from './messages.service.js';

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: RANKS.ADMIN, version: 0 };
const ID = '11111111-1111-4111-8111-111111111111';

/** Parties d'un envoi multipart, telles que `@fastify/multipart` les rend. */
type Partie =
  | { type: 'field'; fieldname: string; value: unknown }
  | { type: 'file'; fieldname: string; filename: string; toBuffer: () => Promise<Buffer> };

/**
 * Flux multipart — asynchrone pour de vrai, comme celui du plugin.
 *
 * `erreur` permet d'interrompre le flux en cours de route : c'est ainsi que le
 * plugin signale ses propres limites, et la seule façon de vérifier qu'elles
 * sont traduites au lieu de remonter en panne.
 */
async function* flux(parties: readonly Partie[], erreur?: unknown): AsyncGenerator<Partie> {
  for (const partie of parties) {
    await Promise.resolve();
    yield partie;
  }
  if (erreur !== undefined) {
    // Un flux interrompu par autre chose qu'une `Error` est précisément l'un
    // des cas que le contrôleur doit savoir envelopper.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw erreur;
  }
}

function req(parties: Partie[] | null = null, over: Partial<AuthenticatedRequest> = {}) {
  return {
    ip: '203.0.113.10',
    headers: {},
    cookies: {},
    isMultipart: () => parties !== null,
    parts: () => flux(parties ?? []),
    ...over,
  } as unknown as AuthenticatedRequest;
}

/** Requête dont le flux s'interrompt sur `erreur`. */
function reqInterrompue(erreur: unknown): AuthenticatedRequest {
  return {
    ...req(CHAMPS),
    parts: () => flux([champ('subject', 'Bascule v2')], erreur),
  } as unknown as AuthenticatedRequest;
}

function champ(fieldname: string, value: unknown): Partie {
  return { type: 'field', fieldname, value };
}

function fichier(filename: string, octets: Buffer): Partie {
  return { type: 'file', fieldname: 'fichiers', filename, toBuffer: () => Promise.resolve(octets) };
}

/** Les champs minimaux d'un envoi valide. */
const CHAMPS: Partie[] = [
  champ('subject', 'Bascule v2'),
  champ('body', 'Jeudi 14h.'),
  champ('audience', 'tous'),
];

function build() {
  const messages = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    counts: vi.fn().mockResolvedValue({ total: 0, nonLus: 0, interrompt: 0 }),
    get: vi.fn().mockResolvedValue({ id: ID }),
    open: vi.fn().mockResolvedValue({ id: ID }),
    setArchived: vi.fn().mockResolvedValue({ id: ID }),
    markAllRead: vi.fn().mockResolvedValue({ total: 0, nonLus: 0, interrompt: 0 }),
    send: vi.fn().mockResolvedValue({ id: ID }),
    piece: vi
      .fn()
      .mockResolvedValue({ nom: 'capture.png', mime: 'image/png', contenu: Buffer.from([1, 2]) }),
  };
  return {
    messages,
    controller: new MessagesController(messages as unknown as MessagesService),
  };
}

/** Double de `FastifyReply`, chaînable comme l'original. */
function reply() {
  const entetes = new Map<string, string>();
  const objet = {
    header: vi.fn((nom: string, valeur: string) => {
      entetes.set(nom, valeur);
      return objet;
    }),
    send: vi.fn().mockResolvedValue(undefined),
    entetes,
  };
  return objet;
}

describe('MessagesController', () => {
  const reflector = new Reflector();

  describe('gardes de route', () => {
    const routes = [
      'list',
      'counts',
      'get',
      'piece',
      'open',
      'markAllRead',
      'setArchived',
      'send',
    ] as const;

    it('n’exige `messages:write` QUE sur l’envoi', () => {
      // Une permission de lecture ici fermerait la boîte à ceux-là mêmes à qui
      // l'on écrit.
      expect(reflector.get(PERMISSIONS_KEY, MessagesController.prototype.send)).toBe(
        PERMISSIONS.MESSAGES_WRITE,
      );

      for (const route of routes.filter(r => r !== 'send')) {
        expect(reflector.get(PERMISSIONS_KEY, MessagesController.prototype[route])).toBeUndefined();
      }
    });

    it('n’exige AUCUN rang minimal', () => {
      // Le sens de circulation est porté par `messages:write`, pas par le rang :
      // la permission reste accordable à un compte de rang inférieur.
      for (const route of routes) {
        expect(reflector.get(MIN_RANK_KEY, MessagesController.prototype[route])).toBeUndefined();
      }
    });

    it('n’expose aucune route en dehors de celles-ci', () => {
      // Une méthode ajoutée plus tard sans garde ferait tomber ce test, et
      // c'est le but : l'absence de garde est un choix, pas un oubli.
      const declarees = Object.getOwnPropertyNames(MessagesController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (MessagesController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });

      expect(declarees.sort()).toEqual([...routes].sort());
    });

    it('n’offre NI suppression NI réécriture d’un message', () => {
      // Le corps appartient à son auteur, et sa copie à chaque destinataire :
      // l'effacer réécrirait ce qui a été dit.
      const noms = Object.getOwnPropertyNames(MessagesController.prototype);
      expect(noms).not.toContain('remove');
      expect(noms).not.toContain('update');
    });
  });

  describe('construction de l’acteur', () => {
    it('transmet l’IP, et accepte son absence', async () => {
      const t = build();
      await t.controller.list({ limit: 25, offset: 0 }, USER, req(null, { ip: undefined }));

      expect(t.messages.list).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'u1', username: 'alice', ipAddress: null }),
      );
    });
  });

  describe('téléchargement', () => {
    it('force le téléchargement et interdit la réinterprétation', async () => {
      const t = build();
      const rep = reply();
      await t.controller.piece(ID, USER, req(), rep as never);

      expect(rep.entetes.get('Content-Disposition')).toContain('attachment;');
      expect(rep.entetes.get('X-Content-Type-Options')).toBe('nosniff');
      expect(rep.entetes.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(rep.entetes.get('Content-Type')).toBe('image/png');
    });

    it('ENCODE le nom dans l’en-tête', async () => {
      // Un nom légitime mais non ASCII couperait l'en-tête ou s'y afficherait
      // faux.
      const t = build();
      t.messages.piece.mockResolvedValueOnce({
        nom: 'capture écran.png',
        mime: 'image/png',
        contenu: Buffer.from([1]),
      });
      const rep = reply();
      await t.controller.piece(ID, USER, req(), rep as never);

      expect(rep.entetes.get('Content-Disposition')).toBe(
        "attachment; filename*=UTF-8''capture%20%C3%A9cran.png",
      );
    });

    it('n’autorise AUCUNE mise en cache partagée', async () => {
      const t = build();
      const rep = reply();
      await t.controller.piece(ID, USER, req(), rep as never);

      expect(rep.entetes.get('Cache-Control')).toBe('private, no-store');
    });
  });

  describe('envoi multipart', () => {
    it('REFUSE une charge qui n’est pas du multipart', async () => {
      const t = build();
      await expect(t.controller.send(USER, req(null))).rejects.toThrow(BadRequestException);
      expect(t.messages.send).not.toHaveBeenCalled();
    });

    it('applique le schéma PARTAGÉ aux champs extraits', async () => {
      const t = build();
      await t.controller.send(USER, req(CHAMPS));

      expect(t.messages.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Bascule v2', audience: 'tous', importance: 'normale' }),
        [],
        expect.anything(),
      );
    });

    it('REFUSE un envoi que le schéma rejette, en NOMMANT le champ', async () => {
      const t = build();
      const refus = await t.controller
        .send(USER, req([champ('subject', 'ab'), champ('body', 'x'), champ('audience', 'tous')]))
        .catch((e: Error) => e);

      expect(refus).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((refus as BadRequestException).getResponse())).toContain('subject');
      expect(t.messages.send).not.toHaveBeenCalled();
    });

    it('lit `recipientIds` comme un tableau JSON', async () => {
      const t = build();
      await t.controller.send(
        USER,
        req([
          champ('subject', 'Bascule v2'),
          champ('body', 'Jeudi.'),
          champ('audience', 'comptes'),
          champ('recipientIds', JSON.stringify([ID])),
        ]),
      );

      expect(t.messages.send).toHaveBeenCalledWith(
        expect.objectContaining({ recipientIds: [ID] }),
        [],
        expect.anything(),
      );
    });

    it('REFUSE un `recipientIds` illisible plutôt que de l’ignorer', async () => {
      // Se replier sur un tableau vide enverrait le message à la mauvaise
      // audience — ou à personne, en silence.
      const t = build();
      await expect(
        t.controller.send(USER, req([...CHAMPS, champ('recipientIds', '[u-1, u-2')])),
      ).rejects.toThrow(/tableau JSON/);
    });

    it('transmet les fichiers avec le nom ANNONCÉ, sans l’interpréter', async () => {
      const t = build();
      await t.controller.send(
        USER,
        req([...CHAMPS, fichier('../../etc/passwd', Buffer.from([0x89, 0x50]))]),
      );

      expect(t.messages.send).toHaveBeenCalledWith(
        expect.anything(),
        [{ nomAnnonce: '../../etc/passwd', octets: Buffer.from([0x89, 0x50]) }],
        expect.anything(),
      );
    });

    it('REFUSE une quatrième pièce jointe', async () => {
      const t = build();
      const octets = Buffer.from([0x89]);
      await expect(
        t.controller.send(
          USER,
          req([
            ...CHAMPS,
            fichier('1.png', octets),
            fichier('2.png', octets),
            fichier('3.png', octets),
            fichier('4.png', octets),
          ]),
        ),
      ).rejects.toThrow(/Au plus 3/);
      expect(t.messages.send).not.toHaveBeenCalled();
    });

    it('NOMME la clé surnuméraire que le schéma refuse', async () => {
      // Une clé que l'audience n'attend pas est rejetée à la RACINE : sans
      // repli, le refus ne dirait pas de quoi il parle.
      const t = build();
      const refus = await t.controller
        .send(USER, req([...CHAMPS, champ('audienceRank', '50')]))
        .catch((e: Error) => e);

      expect(refus).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((refus as BadRequestException).getResponse())).toContain(
        'audienceRank',
      );
    });

    it.each([
      ['FST_FILES_LIMIT', /Au plus 3/],
      ['FST_PARTS_LIMIT', /Au plus 3/],
      ['FST_REQ_FILE_TOO_LARGE', /volumineuse/],
      ['FST_FIELDS_LIMIT', /malformé/],
      ['FST_FIELD_SIZE_LIMIT', /malformé/],
    ])('TRADUIT l’erreur %s du plugin en refus, jamais en panne', async (code, attendu) => {
      // Sans traduction, dépasser une limite de transport rend un 500 : une
      // erreur de l'appelant présentée comme une panne du serveur.
      const t = build();
      const requete = reqInterrompue(Object.assign(new Error('limite'), { code }));

      const refus = await t.controller.send(USER, requete).catch((e: Error) => e);
      expect(refus).toBeInstanceOf(BadRequestException);
      expect((refus as Error).message).toMatch(attendu);
    });

    it('LAISSE PASSER une erreur inattendue plutôt que de la déguiser', async () => {
      // Une panne réelle doit rester une panne : la traduire en 400 ferait
      // croire à l'appelant qu'il a mal formulé sa demande.
      const t = build();

      await expect(
        t.controller.send(USER, reqInterrompue(new Error('disque plein'))),
      ).rejects.toThrow('disque plein');
    });

    it('enveloppe ce qui n’est même pas une erreur', async () => {
      const t = build();

      await expect(t.controller.send(USER, reqInterrompue('panne sans objet'))).rejects.toThrow(
        /Envoi illisible/,
      );
    });

    it('accepte un champ SANS valeur sans échouer', async () => {
      const t = build();
      await t.controller
        .send(
          USER,
          req([
            champ('subject', 'Bascule v2'),
            champ('body', 'Jeudi.'),
            champ('audience', 'comptes'),
            champ('recipientIds', undefined),
          ]),
        )
        .catch(() => undefined);

      // Un `recipientIds` vide n'est pas un tableau : le refus vient du
      // schéma, pas d'un plantage de lecture.
      expect(t.messages.send).not.toHaveBeenCalled();
    });

    it('REFUSE une pièce jointe trop volumineuse', async () => {
      // La borne est revérifiée ici : s'en remettre au seul plugin ferait
      // dépendre une règle métier d'un réglage de transport.
      const t = build();
      await expect(
        t.controller.send(USER, req([...CHAMPS, fichier('gros.png', Buffer.alloc(5_242_881))])),
      ).rejects.toThrow(/volumineuse/);
    });
  });

  describe('délégation', () => {
    it('transmet la requête de liste telle quelle', async () => {
      const t = build();
      await t.controller.list({ limit: 10, offset: 5, unread: true }, USER, req());

      expect(t.messages.list).toHaveBeenCalledWith(
        { limit: 10, offset: 5, unread: true },
        expect.anything(),
      );
    });

    it('relaie l’archivage demandé', async () => {
      const t = build();
      await t.controller.setArchived(ID, { archived: true }, USER, req());
      await t.controller.setArchived(ID, { archived: false }, USER, req());

      expect(t.messages.setArchived).toHaveBeenNthCalledWith(1, ID, true, expect.anything());
      expect(t.messages.setArchived).toHaveBeenNthCalledWith(2, ID, false, expect.anything());
    });

    it('relaie l’ouverture, les compteurs et le « tout lu »', async () => {
      const t = build();
      await t.controller.open(ID, USER, req());
      await t.controller.counts(USER, req());
      await t.controller.markAllRead(USER, req());
      await t.controller.get(ID, USER, req());

      expect(t.messages.open).toHaveBeenCalledWith(ID, expect.anything());
      expect(t.messages.counts).toHaveBeenCalled();
      expect(t.messages.markAllRead).toHaveBeenCalled();
      expect(t.messages.get).toHaveBeenCalledWith(ID, expect.anything());
    });
  });
});
