import { describe, expect, it } from 'vitest';

import {
  CreateMessageSchema,
  MessageCountsSchema,
  MessageQuerySchema,
  MessageSchema,
  MIMES_PIECE_JOINTE,
  NOMBRE_MAX_PIECES_JOINTES,
  nomAffichable,
  PieceJointeSchema,
  sInterrompt,
  TAILLE_MAX_PIECE_JOINTE,
  typeReconnu,
  TYPES_PIECE_JOINTE,
} from './message.schema.js';

/** Octets d'un fichier dont seule l'empreinte compte ici. */
function fichier(...octets: number[]): Uint8Array {
  return Uint8Array.from([...octets, ...Array.from({ length: 32 }, () => 0x00)]);
}

const PNG = fichier(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = fichier(0xff, 0xd8, 0xff, 0xe0);
const PDF = fichier(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);

const ENVOI = {
  subject: 'Bascule v2 jeudi',
  body: 'La bascule est programmée jeudi 14h. Aucun audit ne sera perdu.',
  audience: 'tous' as const,
};

describe('sInterrompt', () => {
  it('ne laisse QUE « critique » s’imposer à l’écran', () => {
    expect(sInterrompt('critique')).toBe(true);
    expect(sInterrompt('haute')).toBe(false);
    expect(sInterrompt('normale')).toBe(false);
  });
});

describe('typeReconnu', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['application/pdf', PDF],
    ['image/webp', WEBP],
  ])('reconnaît %s à son empreinte', (mime, octets) => {
    expect(typeReconnu(octets)).toBe(mime);
  });

  it('REFUSE un conteneur RIFF qui n’est pas une image WebP', () => {
    // Même en-tête qu'un WebP, autre contenu : c'est exactement le cas que la
    // seconde signature existe pour attraper.
    const riffAudio = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(typeReconnu(riffAudio)).toBeNull();
  });

  it('REFUSE un exécutable et un script, quoi qu’annonce leur nom', () => {
    expect(typeReconnu(fichier(0x4d, 0x5a))).toBeNull();
    expect(typeReconnu(fichier(0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e))).toBeNull();
  });

  it('REFUSE un fichier TRONQUÉ dont l’empreinte est incomplète', () => {
    // Les trois premiers octets d'un PNG ne font pas un PNG : lire au-delà de
    // la fin du tampon rend `undefined`, qui ne concorde avec rien.
    expect(typeReconnu(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('REFUSE un fichier VIDE', () => {
    expect(typeReconnu(new Uint8Array(0))).toBeNull();
  });

  it('n’admet aucun type hors du catalogue', () => {
    expect(MIMES_PIECE_JOINTE).toHaveLength(Object.keys(TYPES_PIECE_JOINTE).length);
    for (const mime of MIMES_PIECE_JOINTE) {
      expect(TYPES_PIECE_JOINTE[mime].signatures.length).toBeGreaterThan(0);
    }
  });
});

describe('nomAffichable', () => {
  it('NEUTRALISE les séparateurs de chemin', () => {
    expect(nomAffichable('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(nomAffichable('C:\\Windows\\system32')).toBe('C:_Windows_system32');
  });

  it('retire les caractères de contrôle et les guillemets', () => {
    // Un guillemet refermerait l'en-tête `Content-Disposition`, un saut de
    // ligne y ajouterait un en-tête entier.
    expect(nomAffichable('rapport".txt')).toBe('rapport.txt');
    expect(nomAffichable('capture\r\nX-Injecte: 1.png')).toBe('captureX-Injecte: 1.png');
  });

  it('rend un nom de repli plutôt qu’un en-tête vide', () => {
    expect(nomAffichable('///')).toBe('___');
    expect(nomAffichable('')).toBe('piece-jointe');
    expect(nomAffichable('   ')).toBe('piece-jointe');
    expect(nomAffichable('\u0000\u0001')).toBe('piece-jointe');
  });

  it('BORNE la longueur', () => {
    expect(nomAffichable(`${'a'.repeat(300)}.png`)).toHaveLength(120);
  });

  it('laisse intact un nom déjà sain', () => {
    expect(nomAffichable('capture-écran 2026.png')).toBe('capture-écran 2026.png');
  });
});

describe('PieceJointeSchema', () => {
  const PJ = {
    id: '11111111-1111-4111-8111-111111111111',
    nom: 'capture.png',
    mime: 'image/png',
    taille: 2048,
  };

  it('accepte une pièce jointe conforme', () => {
    expect(PieceJointeSchema.parse(PJ)).toEqual(PJ);
  });

  it('REFUSE un type hors catalogue', () => {
    expect(PieceJointeSchema.safeParse({ ...PJ, mime: 'text/html' }).success).toBe(false);
    expect(PieceJointeSchema.safeParse({ ...PJ, mime: 'image/svg+xml' }).success).toBe(false);
  });

  it('REFUSE une taille nulle ou au-delà du plafond', () => {
    expect(PieceJointeSchema.safeParse({ ...PJ, taille: 0 }).success).toBe(false);
    expect(
      PieceJointeSchema.safeParse({ ...PJ, taille: TAILLE_MAX_PIECE_JOINTE + 1 }).success,
    ).toBe(false);
    expect(PieceJointeSchema.safeParse({ ...PJ, taille: TAILLE_MAX_PIECE_JOINTE }).success).toBe(
      true,
    );
  });

  it('REFUSE un chemin de stockage surnuméraire', () => {
    // Le chemin réel ne sort jamais : l'exposer offrirait la cible d'une
    // traversée à qui lit la réponse.
    expect(PieceJointeSchema.safeParse({ ...PJ, chemin: '/var/data/x.png' }).success).toBe(false);
  });
});

describe('CreateMessageSchema', () => {
  it('accepte une annonce à tous, importance par défaut', () => {
    const parse = CreateMessageSchema.parse(ENVOI);

    expect(parse.importance).toBe('normale');
    // Le TYPE lui-même refuse `parse.audienceRank` sur cette branche : c'est
    // l'union discriminée qui porte l'invariant, pas une vérification.
    expect(parse.audience).toBe('tous');
    expect(Object.keys(parse).sort()).toEqual(['audience', 'body', 'importance', 'subject']);
  });

  it('EXIGE le rang visé sur une audience par rang', () => {
    const refus = CreateMessageSchema.safeParse({ ...ENVOI, audience: 'rang' });
    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.path).toEqual(['audienceRank']);
  });

  it('EXIGE des destinataires sur une audience ciblée', () => {
    const refus = CreateMessageSchema.safeParse({ ...ENVOI, audience: 'comptes' });
    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.path).toEqual(['recipientIds']);
  });

  it('REFUSE une cible que l’audience n’attend pas, en la NOMMANT', () => {
    // Sans ce refus, un envoi « à tous » accompagné d'un rang laisserait croire
    // qu'il a été restreint. L'union discriminée le rejette comme une clé
    // surnuméraire : la branche « tous » ne connaît pas ce champ.
    const rang = CreateMessageSchema.safeParse({ ...ENVOI, audienceRank: 50 });
    expect(rang.success).toBe(false);
    expect(rang.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['audienceRank'],
    });

    const comptes = CreateMessageSchema.safeParse({
      ...ENVOI,
      recipientIds: ['11111111-1111-4111-8111-111111111111'],
    });
    expect(comptes.success).toBe(false);
    expect(comptes.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['recipientIds'],
    });
  });

  it('REFUSE une audience inventée en énumérant celles qui existent', () => {
    const refus = CreateMessageSchema.safeParse({ ...ENVOI, audience: 'monde-entier' });

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.path).toEqual(['audience']);
  });

  it('accepte les deux audiences ciblées correctement formées', () => {
    expect(
      CreateMessageSchema.safeParse({ ...ENVOI, audience: 'rang', audienceRank: 50 }).success,
    ).toBe(true);
    expect(
      CreateMessageSchema.safeParse({
        ...ENVOI,
        audience: 'comptes',
        recipientIds: ['11111111-1111-4111-8111-111111111111'],
      }).success,
    ).toBe(true);
  });

  it('COERCE le rang, qui peut arriver en texte', () => {
    // Un formulaire multipart ne transporte que du texte.
    const parse = CreateMessageSchema.parse({ ...ENVOI, audience: 'rang', audienceRank: '100' });

    expect(parse).toEqual(expect.objectContaining({ audience: 'rang', audienceRank: 100 }));
  });

  it('lit un rang MANQUANT comme manquant, pas comme un nombre illisible', () => {
    // `Number(undefined)` vaut NaN : sans précaution, le refus dirait « nombre
    // attendu, NaN reçu » là où il faut lire « champ requis ».
    const refus = CreateMessageSchema.safeParse({ ...ENVOI, audience: 'rang' });

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).not.toContain('NaN');
  });

  it('REFUSE un rang hors catalogue', () => {
    expect(
      CreateMessageSchema.safeParse({ ...ENVOI, audience: 'rang', audienceRank: 42 }).success,
    ).toBe(false);
  });

  it('BORNE le sujet, le corps et la liste de destinataires', () => {
    expect(CreateMessageSchema.safeParse({ ...ENVOI, subject: 'ab' }).success).toBe(false);
    expect(CreateMessageSchema.safeParse({ ...ENVOI, subject: 'a'.repeat(151) }).success).toBe(
      false,
    );
    expect(CreateMessageSchema.safeParse({ ...ENVOI, body: '' }).success).toBe(false);
    expect(CreateMessageSchema.safeParse({ ...ENVOI, body: 'a'.repeat(10_001) }).success).toBe(
      false,
    );
    expect(
      CreateMessageSchema.safeParse({
        ...ENVOI,
        audience: 'comptes',
        recipientIds: Array.from({ length: 201 }, () => '11111111-1111-4111-8111-111111111111'),
      }).success,
    ).toBe(false);
  });

  it('REJETTE toute clé surnuméraire', () => {
    expect(CreateMessageSchema.safeParse({ ...ENVOI, authorId: 'x' }).success).toBe(false);
    expect(CreateMessageSchema.safeParse({ ...ENVOI, sentAt: '2026-01-01' }).success).toBe(false);
    expect(CreateMessageSchema.safeParse({ ...ENVOI, attachments: [] }).success).toBe(false);
  });

  it('REFUSE une importance inventée', () => {
    expect(CreateMessageSchema.safeParse({ ...ENVOI, importance: 'urgente' }).success).toBe(false);
  });
});

describe('MessageQuerySchema', () => {
  it('pose des bornes de pagination par défaut', () => {
    expect(MessageQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it('COERCE les drapeaux et les nombres, qui arrivent en texte', () => {
    const parse = MessageQuerySchema.parse({
      unread: 'true',
      archived: 'false',
      limit: '50',
      offset: '10',
    });
    expect(parse).toEqual({ unread: true, archived: false, limit: 50, offset: 10 });
  });

  it('REFUSE une pagination hors bornes et un filtre inconnu', () => {
    expect(MessageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(MessageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(MessageQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(MessageQuerySchema.safeParse({ auteur: 'alice' }).success).toBe(false);
  });
});

describe('MessageSchema', () => {
  const VUE = {
    id: '11111111-1111-4111-8111-111111111111',
    subject: 'Bascule v2',
    body: 'Jeudi 14h.',
    importance: 'haute',
    authorId: '22222222-2222-4222-8222-222222222222',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-09-23T10:00:00.000Z',
    readAt: null,
    archivedAt: null,
  };

  it('accepte une vue conforme, auteur supprimé compris', () => {
    expect(MessageSchema.parse(VUE)).toEqual(VUE);
    expect(MessageSchema.safeParse({ ...VUE, authorId: null, authorName: null }).success).toBe(
      true,
    );
  });

  it('n’admet AUCUN champ hors du contrat', () => {
    // Les destinataires des autres comptes ne regardent pas celui qui lit.
    expect(MessageSchema.safeParse({ ...VUE, recipients: ['bob'] }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...VUE, audience: 'tous' }).success).toBe(false);
  });

  it('borne le nombre de pièces jointes par la constante partagée', () => {
    expect(NOMBRE_MAX_PIECES_JOINTES).toBe(3);
  });
});

describe('MessageCountsSchema', () => {
  it('exige les trois compteurs, zéros compris', () => {
    expect(MessageCountsSchema.parse({ total: 0, nonLus: 0, interrompt: 0 })).toEqual({
      total: 0,
      nonLus: 0,
      interrompt: 0,
    });
    expect(MessageCountsSchema.safeParse({ total: 3, nonLus: 1 }).success).toBe(false);
    expect(MessageCountsSchema.safeParse({ total: -1, nonLus: 0, interrompt: 0 }).success).toBe(
      false,
    );
  });
});
