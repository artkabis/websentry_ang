import { describe, expect, it } from 'vitest';
import type { Message } from '@websentry/shared';
import {
  ACCEPT_PIECES,
  BROUILLON_MESSAGE_VIDE,
  chargeMessage,
  doitInterrompre,
  EXTENSIONS_ACCEPTEES,
  FILTRES_MESSAGES_VIDES,
  filtresMessagesActifs,
  filtresMessagesDepuisParams,
  filtresMessagesVersRequete,
  formaterTaille,
  libelleAudience,
  libelleImportance,
  messageValide,
  nombreDePagesMessages,
  paramsDepuisFiltresMessages,
  premiereIrruption,
  problemesMessage,
  problemesPieces,
} from './message-format';

const ID = '11111111-1111-4111-8111-111111111111';

function fichier(nom: string, octets: number, type = ''): File {
  return new File([new Uint8Array(octets)], nom, { type });
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    subject: 'Bascule',
    body: 'Jeudi.',
    importance: 'normale',
    authorId: 'u-1',
    authorName: 'alice',
    attachments: [],
    sentAt: '2026-01-01T00:00:00.000Z',
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

describe('filtres de la boîte', () => {
  it('rend des filtres vides sans paramètre', () => {
    expect(filtresMessagesDepuisParams({})).toEqual(FILTRES_MESSAGES_VIDES);
  });

  it('ne retient QUE « oui » comme vrai', () => {
    // Un paramètre d'URL est du texte : « false » y serait une chaîne
    // parfaitement vraie.
    expect(filtresMessagesDepuisParams({ nonlus: 'oui' }).unread).toBe(true);
    expect(filtresMessagesDepuisParams({ nonlus: 'false' }).unread).toBe(false);
    expect(filtresMessagesDepuisParams({ nonlus: 'true' }).unread).toBe(false);
    expect(filtresMessagesDepuisParams({ archives: 'oui' }).archived).toBe(true);
  });

  it('IGNORE une importance hors catalogue', () => {
    expect(filtresMessagesDepuisParams({ importance: 'urgentissime' }).importance).toBe('');
    expect(filtresMessagesDepuisParams({ importance: 'critique' }).importance).toBe('critique');
  });

  it('IGNORE une page absurde', () => {
    for (const page of ['0', '-3', 'deux', '1.5', '']) {
      expect(filtresMessagesDepuisParams({ page }).page).toBe(1);
    }
    expect(filtresMessagesDepuisParams({ page: '4' }).page).toBe(4);
  });

  it('coupe les espaces de la recherche', () => {
    expect(filtresMessagesDepuisParams({ recherche: '  bascule  ' }).search).toBe('bascule');
  });

  it('fait un ALLER-RETOUR sans perte', () => {
    const filtres = {
      unread: true,
      importance: 'critique',
      search: 'bascule',
      archived: true,
      page: 3,
    };
    expect(filtresMessagesDepuisParams(paramsDepuisFiltresMessages(filtres))).toEqual(filtres);
  });

  it('n’écrit AUCUN paramètre pour un filtre vide', () => {
    // Une URL propre se partage ; une URL pleine de valeurs par défaut ment
    // sur ce qui a été choisi.
    expect(paramsDepuisFiltresMessages(FILTRES_MESSAGES_VIDES)).toEqual({});
  });

  it('traduit les filtres en requête, décalage compris', () => {
    expect(filtresMessagesVersRequete({ ...FILTRES_MESSAGES_VIDES, page: 3 }, 25)).toEqual({
      limit: 25,
      offset: 50,
    });
    expect(
      filtresMessagesVersRequete(
        { unread: true, importance: 'haute', search: 'x', archived: true, page: 1 },
        25,
      ),
    ).toEqual({
      limit: 25,
      offset: 0,
      unread: true,
      importance: 'haute',
      search: 'x',
      archived: true,
    });
  });

  it('dit si un filtre est posé', () => {
    expect(filtresMessagesActifs(FILTRES_MESSAGES_VIDES)).toBe(false);
    expect(filtresMessagesActifs({ ...FILTRES_MESSAGES_VIDES, unread: true })).toBe(true);
    expect(filtresMessagesActifs({ ...FILTRES_MESSAGES_VIDES, search: 'x' })).toBe(true);
    expect(filtresMessagesActifs({ ...FILTRES_MESSAGES_VIDES, archived: true })).toBe(true);
    expect(filtresMessagesActifs({ ...FILTRES_MESSAGES_VIDES, importance: 'haute' })).toBe(true);
    // La page n'est PAS un filtre : elle ne change pas ce qu'on cherche.
    expect(filtresMessagesActifs({ ...FILTRES_MESSAGES_VIDES, page: 4 })).toBe(false);
  });

  it('compte au moins UNE page, même vide', () => {
    expect(nombreDePagesMessages(0)).toBe(1);
    expect(nombreDePagesMessages(25)).toBe(1);
    expect(nombreDePagesMessages(26)).toBe(2);
  });
});

describe('composition', () => {
  const VALIDE = {
    ...BROUILLON_MESSAGE_VIDE,
    subject: 'Bascule v2 jeudi',
    body: 'La bascule est programmée jeudi à 14h.',
  };

  it('n’envoie que la cible de l’audience choisie', () => {
    expect(chargeMessage(VALIDE)).not.toHaveProperty('audienceRank');
    expect(chargeMessage(VALIDE)).not.toHaveProperty('recipientIds');

    const parRang = chargeMessage({ ...VALIDE, audience: 'rang', audienceRank: '50' });
    expect(parRang['audienceRank']).toBe('50');
    expect(parRang).not.toHaveProperty('recipientIds');

    const parComptes = chargeMessage({ ...VALIDE, audience: 'comptes', recipientIds: [ID] });
    expect(parComptes['recipientIds']).toEqual([ID]);
    expect(parComptes).not.toHaveProperty('audienceRank');
  });

  it('COUPE les espaces autour de l’objet et du message', () => {
    const charge = chargeMessage({ ...VALIDE, subject: '  Objet  ', body: '  Corps.  ' });
    expect(charge['subject']).toBe('Objet');
    expect(charge['body']).toBe('Corps.');
  });

  it('accepte un brouillon complet', () => {
    expect(problemesMessage(VALIDE)).toEqual([]);
    expect(messageValide(VALIDE)).not.toBeNull();
  });

  it('NOMME le champ fautif, en français', () => {
    const problemes = problemesMessage({ ...VALIDE, subject: 'ab' });
    expect(problemes.some(p => p.startsWith('Objet :'))).toBe(true);
  });

  it('rend la cible surnuméraire IMPOSSIBLE plutôt que de la signaler', () => {
    // Un rang saisi puis abandonné reste dans le brouillon ; la charge ne le
    // recopie pas. L'auteur n'a donc jamais à comprendre un refus portant sur
    // une clé qu'il ne voit plus à l'écran.
    const abandonne = { ...VALIDE, audience: 'tous', audienceRank: '50', recipientIds: [ID] };

    expect(chargeMessage(abandonne)).toEqual({
      subject: 'Bascule v2 jeudi',
      body: 'La bascule est programmée jeudi à 14h.',
      importance: 'normale',
      audience: 'tous',
    });
    expect(problemesMessage(abandonne)).toEqual([]);
  });

  it('NOMME le rang manquant d’un envoi par rang', () => {
    const problemes = problemesMessage({ ...VALIDE, audience: 'rang' });
    expect(problemes.some(p => p.startsWith('Rang visé :'))).toBe(true);
  });

  it('NOMME les comptes manquants d’un envoi ciblé', () => {
    const problemes = problemesMessage({ ...VALIDE, audience: 'comptes', recipientIds: [] });
    expect(problemes.some(p => p.startsWith('Comptes visés :'))).toBe(true);
  });

  it('REFUSE un envoi par rang sans rang', () => {
    expect(messageValide({ ...VALIDE, audience: 'rang' })).toBeNull();
    expect(problemesMessage({ ...VALIDE, audience: 'rang' }).length).toBeGreaterThan(0);
  });

  it('REFUSE un envoi ciblé sans destinataire', () => {
    expect(messageValide({ ...VALIDE, audience: 'comptes', recipientIds: [] })).toBeNull();
  });

  it('accepte un envoi par rang correctement formé', () => {
    expect(messageValide({ ...VALIDE, audience: 'rang', audienceRank: '100' })).not.toBeNull();
  });
});

describe('pièces jointes', () => {
  it('propose extensions ET types dans l’attribut accept', () => {
    // Les navigateurs ne lisent pas tous le même dialecte.
    expect(EXTENSIONS_ACCEPTEES).toContain('.png');
    expect(ACCEPT_PIECES).toContain('.pdf');
    expect(ACCEPT_PIECES).toContain('image/webp');
  });

  it('n’a RIEN à reprocher à un lot vide', () => {
    expect(problemesPieces([])).toEqual([]);
  });

  it('accepte un fichier reconnu par son TYPE annoncé', () => {
    expect(problemesPieces([fichier('capture', 10, 'image/png')])).toEqual([]);
  });

  it('accepte un fichier reconnu par sa seule EXTENSION', () => {
    // Un système mal configuré peut ne rien déclarer : refuser pour cette
    // seule raison serait incompréhensible.
    expect(problemesPieces([fichier('capture.PNG', 10)])).toEqual([]);
  });

  it('REFUSE un format hors liste, et le NOMME', () => {
    const problemes = problemesPieces([fichier('outil.exe', 10, 'application/x-msdownload')]);
    expect(problemes).toHaveLength(1);
    expect(problemes[0]).toContain('outil.exe');
  });

  it('REFUSE un fichier sans extension ni type', () => {
    expect(problemesPieces([fichier('sansrien', 10)])).toHaveLength(1);
  });

  it('REFUSE un fichier vide', () => {
    expect(problemesPieces([fichier('vide.png', 0, 'image/png')])[0]).toContain('est vide');
  });

  it('REFUSE au-delà du plafond de taille', () => {
    const trop = fichier('gros.png', 5 * 1024 * 1024 + 1, 'image/png');
    expect(problemesPieces([trop])[0]).toContain('dépasse');
  });

  it('REFUSE au-delà du nombre de pièces', () => {
    const lot = Array.from({ length: 4 }, (_, i) => fichier(`${i}.png`, 10, 'image/png'));
    expect(problemesPieces(lot)[0]).toContain('Au plus 3');
  });

  it('SIGNALE chaque fichier fautif, pas seulement le premier', () => {
    const problemes = problemesPieces([
      fichier('bon.png', 10, 'image/png'),
      fichier('mauvais.exe', 10),
      fichier('vide.pdf', 0, 'application/pdf'),
    ]);
    expect(problemes).toHaveLength(2);
  });
});

describe('formatage', () => {
  it('écrit une taille lisible', () => {
    expect(formaterTaille(512)).toBe('512 o');
    expect(formaterTaille(2048)).toBe('2 ko');
    expect(formaterTaille(1024 * 1024)).toBe('1,0 Mo');
    expect(formaterTaille(5 * 1024 * 1024)).toBe('5,0 Mo');
  });

  it('traduit importance et audience', () => {
    expect(libelleImportance('critique')).toBe('Critique');
    expect(libelleAudience('tous')).toBe('Tous les comptes actifs');
    // Une valeur inconnue se rend telle quelle plutôt que de disparaître.
    expect(libelleImportance('inconnue')).toBe('inconnue');
    expect(libelleAudience('inconnue')).toBe('inconnue');
  });
});

describe('irruption', () => {
  it('ne s’impose QUE pour un critique NON LU', () => {
    expect(doitInterrompre(message({ importance: 'critique' }))).toBe(true);
    expect(doitInterrompre(message({ importance: 'haute' }))).toBe(false);
    expect(
      doitInterrompre(message({ importance: 'critique', readAt: '2026-01-02T00:00:00.000Z' })),
    ).toBe(false);
  });

  it('retient le PREMIER à s’imposer, et rend null sinon', () => {
    const liste = [
      message({ id: 'a', importance: 'haute' }),
      message({ id: 'b', importance: 'critique' }),
      message({ id: 'c', importance: 'critique' }),
    ];
    expect(premiereIrruption(liste)?.id).toBe('b');
    expect(premiereIrruption([])).toBeNull();
    expect(premiereIrruption([message({ importance: 'normale' })])).toBeNull();
  });
});
