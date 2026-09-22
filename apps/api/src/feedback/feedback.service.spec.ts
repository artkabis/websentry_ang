import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FeedbackQuery } from '@websentry/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type {
  FeedbackRepository,
  FeedbackRow,
} from '../database/repositories/feedback.repository.js';
import { FeedbackService, type FeedbackActor } from './feedback.service.js';

const ID_RETOUR = '11111111-1111-4111-8111-111111111111';
const ID_AUTEUR = '22222222-2222-4222-8222-222222222222';
const ID_AUTRE = '33333333-3333-4333-8333-333333333333';

/**
 * Champs d'un retour, sans l'héritage `RowDataPacket` de mysql2 : celui-ci
 * porte un `constructor.name` littéral qu'aucun objet de test ne peut avoir.
 */
type ChampsRetour = Pick<
  FeedbackRow,
  | 'id'
  | 'kind'
  | 'severity'
  | 'status'
  | 'title'
  | 'body'
  | 'context'
  | 'author_id'
  | 'author_name'
  | 'assigned_to'
  | 'assigned_name'
  | 'resolution'
  | 'created_at'
  | 'updated_at'
  | 'resolved_at'
>;

function ligne(over: Partial<ChampsRetour> = {}): FeedbackRow {
  return {
    id: ID_RETOUR,
    kind: 'bug',
    severity: 'majeur',
    status: 'nouveau',
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
    context: { route: '/profils/premium', targetUrl: null, gamme: 'premium' },
    author_id: ID_AUTEUR,
    author_name: 'bob',
    assigned_to: null,
    assigned_name: null,
    resolution: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
    ...over,
  } as FeedbackRow;
}

const AUTEUR: FeedbackActor = {
  id: ID_AUTEUR,
  username: 'bob',
  ipAddress: '203.0.113.7',
  peutTrier: false,
};
const TRIEUR: FeedbackActor = {
  id: ID_AUTRE,
  username: 'alice',
  ipAddress: '203.0.113.8',
  peutTrier: true,
};

interface Surcharges {
  repo?: Record<string, unknown>;
}

function setup(over: Surcharges = {}) {
  const repo = {
    available: true,
    list: vi.fn().mockResolvedValue([ligne()]),
    count: vi.fn().mockResolvedValue(1),
    countByStatus: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(ligne()),
    create: vi.fn().mockResolvedValue(undefined),
    triage: vi.fn().mockResolvedValue(1),
    ...over.repo,
  } as unknown as FeedbackRepository;

  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  return { repo, audit, service: new FeedbackService(repo, audit) };
}

function requete(over: Partial<FeedbackQuery> = {}): FeedbackQuery {
  return { limit: 25, offset: 0, ...over };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('sans base de données', () => {
  it('REFUSE clairement plutôt qu’à moitié', async () => {
    const sansBase = setup({ repo: { available: false } });
    await expect(sansBase.service.list(requete(), AUTEUR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(sansBase.service.counts(AUTEUR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('visibilité', () => {
  it('RESTREINT la liste à ses propres retours sans feedback:read', async () => {
    // La restriction est posée sur le filtre SQL, pas après coup : filtrer en
    // mémoire ramènerait d'abord les retours des autres, et la pagination
    // calculée dessus serait fausse.
    await t.service.list(requete(), AUTEUR);

    expect(t.repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: ID_AUTEUR }),
      25,
      0,
    );
  });

  it('applique au COMPTAGE le même filtre qu’à la liste', async () => {
    await t.service.list(requete({ status: 'nouveau' }), AUTEUR);

    const [filtresListe] = vi.mocked(t.repo.list).mock.calls[0] ?? [];
    expect(t.repo.count).toHaveBeenCalledWith(filtresListe);
  });

  it('OUVRE la liste entière à qui détient feedback:read', async () => {
    await t.service.list(requete(), TRIEUR);

    const [filtres] = vi.mocked(t.repo.list).mock.calls[0] ?? [];
    expect(filtres).not.toHaveProperty('authorId');
  });

  it('laisse un trieur demander SES retours', async () => {
    await t.service.list(requete({ mine: true }), TRIEUR);

    expect(t.repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: ID_AUTRE }),
      25,
      0,
    );
  });

  it('IGNORE « mine=false » chez qui ne peut pas tout voir', async () => {
    // Sans cela, il suffirait d'ajouter un paramètre à l'URL pour lire les
    // retours des autres.
    await t.service.list(requete({ mine: false }), AUTEUR);

    expect(t.repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: ID_AUTEUR }),
      25,
      0,
    );
  });

  it('transmet les autres filtres tels quels', async () => {
    await t.service.list(
      requete({ status: 'accepte', kind: 'suggestion', severity: 'mineur', search: 'score' }),
      TRIEUR,
    );

    expect(t.repo.list).toHaveBeenCalledWith(
      { status: 'accepte', kind: 'suggestion', severity: 'mineur', search: 'score' },
      25,
      0,
    );
  });
});

describe('lecture unitaire', () => {
  it('rend son propre retour à son auteur', async () => {
    expect((await t.service.get(ID_RETOUR, AUTEUR)).id).toBe(ID_RETOUR);
  });

  it('rend n’importe quel retour à un trieur', async () => {
    expect((await t.service.get(ID_RETOUR, TRIEUR)).id).toBe(ID_RETOUR);
  });

  it('répond 404 — et NON 403 — sur le retour d’un autre', async () => {
    // Un 403 confirmerait qu'un retour existe sous cet identifiant, ce qui est
    // déjà une information.
    const etranger = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ author_id: ID_AUTRE })) },
    });

    await expect(etranger.service.get(ID_RETOUR, AUTEUR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('répond 404 sur un retour inexistant', async () => {
    const absent = setup({ repo: { findById: vi.fn().mockResolvedValue(null) } });
    await expect(absent.service.get(ID_RETOUR, AUTEUR)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('dépôt', () => {
  const ENTREE = {
    kind: 'bug' as const,
    severity: 'majeur' as const,
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score reste celui d’avant.',
  };

  it('est ouvert à TOUT compte, sans permission', async () => {
    // Si signaler coûte une permission à demander, personne ne signale.
    await expect(t.service.create(ENTREE, AUTEUR)).resolves.toMatchObject({ id: ID_RETOUR });
  });

  it('FIGE le nom de l’auteur au dépôt', async () => {
    // Il survit à la suppression du compte, alors que la clé étrangère passera
    // à NULL.
    await t.service.create(ENTREE, AUTEUR);

    expect(t.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: ID_AUTEUR, authorName: 'bob' }),
    );
  });

  it('ne laisse PAS choisir le statut initial', async () => {
    await t.service.create(ENTREE, AUTEUR);

    const [cree] = vi.mocked(t.repo.create).mock.calls[0] ?? [];
    expect(cree).not.toHaveProperty('status');
  });

  it('accepte un dépôt sans contexte', async () => {
    await t.service.create(ENTREE, AUTEUR);
    expect(vi.mocked(t.repo.create).mock.calls[0]?.[0].context).toBeNull();
  });

  it('trace le dépôt SANS y recopier le corps', async () => {
    // Le corps peut contenir des URL clientes : le journal d'audit se lit plus
    // largement que la table des retours.
    await t.service.create(ENTREE, AUTEUR);

    const trace = vi.mocked(t.audit.record).mock.calls[0]?.[0];
    expect(trace?.action).toBe('feedback.create');
    expect(JSON.stringify(trace?.details)).not.toContain('pondération');
  });
});

describe('triage', () => {
  it('REFUSE le triage à qui n’a pas feedback:read', async () => {
    await expect(t.service.triage(ID_RETOUR, { status: 'accepte' }, AUTEUR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.repo.triage).not.toHaveBeenCalled();
  });

  it('REFUSE à un auteur de classer SON PROPRE retour, faute de permission', async () => {
    // Sans quoi chacun classerait ses signalements « résolus ». Le refus vient
    // de la permission, pas d'une règle sur l'auteur : un trieur qui dépose un
    // retour peut le trier comme les autres, et c'est normal.
    const sien = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ author_id: ID_AUTEUR })) },
    });

    await expect(
      sien.service.triage(ID_RETOUR, { status: 'resolu' }, AUTEUR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('laisse un TRIEUR classer le retour qu’il a lui-même déposé', async () => {
    const sien = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ author_id: ID_AUTRE })) },
    });

    await expect(
      sien.service.triage(ID_RETOUR, { status: 'accepte' }, TRIEUR),
    ).resolves.toBeDefined();
  });

  it('accepte une transition légitime', async () => {
    await t.service.triage(ID_RETOUR, { status: 'accepte' }, TRIEUR);
    expect(t.repo.triage).toHaveBeenCalledWith(
      ID_RETOUR,
      expect.objectContaining({ status: 'accepte' }),
    );
  });

  it('REFUSE de sauter du dépôt à la résolution', async () => {
    // Le chemin parcouru raconte ce qui s'est passé : un retour « résolu »
    // jamais passé par « en cours » n'a jamais été travaillé.
    await expect(t.service.triage(ID_RETOUR, { status: 'resolu' }, TRIEUR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(t.repo.triage).not.toHaveBeenCalled();
  });

  it('NOMME le passage refusé dans le message', async () => {
    await expect(t.service.triage(ID_RETOUR, { status: 'resolu' }, TRIEUR)).rejects.toThrow(
      /nouveau.*resolu/,
    );
  });

  it('laisse ROUVRIR un retour résolu', async () => {
    const resolu = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ status: 'resolu' })) },
    });

    await resolu.service.triage(ID_RETOUR, { status: 'en_cours' }, TRIEUR);
    expect(resolu.repo.triage).toHaveBeenCalled();
  });

  it('REFUSE un statut que cette version ne connaît pas', async () => {
    // Une base écrite par une version plus récente ne doit pas faire prendre
    // une transition au hasard.
    const inconnu = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ status: 'archive' })) },
    });

    await expect(
      inconnu.service.triage(ID_RETOUR, { status: 'accepte' }, TRIEUR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('laisse changer la gravité SANS toucher au statut', async () => {
    await t.service.triage(ID_RETOUR, { severity: 'bloquant' }, TRIEUR);

    const [, champs] = vi.mocked(t.repo.triage).mock.calls[0] ?? [];
    expect(champs).toMatchObject({ severity: 'bloquant' });
    expect(champs?.status).toBeUndefined();
  });

  it('DISTINGUE une désassignation d’une absence', async () => {
    await t.service.triage(ID_RETOUR, { assignedTo: null }, TRIEUR);
    expect(vi.mocked(t.repo.triage).mock.calls[0]?.[1]).toMatchObject({ assigned_to: null });

    const autre = setup();
    await autre.service.triage(ID_RETOUR, { severity: 'mineur' }, TRIEUR);
    expect(vi.mocked(autre.repo.triage).mock.calls[0]?.[1].assigned_to).toBeUndefined();
  });

  it('trace le triage', async () => {
    await t.service.triage(ID_RETOUR, { status: 'accepte' }, TRIEUR);

    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'feedback.triage', actorId: ID_AUTRE }),
    );
  });

  it('répond 404 sur un retour inexistant, avant tout contrôle de transition', async () => {
    const absent = setup({ repo: { findById: vi.fn().mockResolvedValue(null) } });
    await expect(
      absent.service.triage(ID_RETOUR, { status: 'resolu' }, TRIEUR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('compteurs', () => {
  it('rend TOUS les statuts, zéros compris', async () => {
    // Un écran de triage qui masque les statuts vides fait croire qu'ils
    // n'existent pas.
    const compte = setup({
      repo: { countByStatus: vi.fn().mockResolvedValue([{ status: 'nouveau', total: 3 }]) },
    });

    expect(await compte.service.counts(TRIEUR)).toEqual({
      nouveau: 3,
      accepte: 0,
      en_cours: 0,
      resolu: 0,
      rejete: 0,
    });
  });

  it('IGNORE un statut inconnu plutôt que d’ajouter une clé', async () => {
    const futur = setup({
      repo: {
        countByStatus: vi.fn().mockResolvedValue([
          { status: 'nouveau', total: 1 },
          { status: 'archive', total: 9 },
        ]),
      },
    });

    expect(await futur.service.counts(TRIEUR)).not.toHaveProperty('archive');
  });

  it('RESTREINT les compteurs à ses propres retours sans feedback:read', async () => {
    await t.service.counts(AUTEUR);
    expect(t.repo.countByStatus).toHaveBeenCalledWith({ authorId: ID_AUTEUR });
  });

  it('compte tout pour un trieur', async () => {
    await t.service.counts(TRIEUR);
    expect(t.repo.countByStatus).toHaveBeenCalledWith({});
  });
});

describe('horodatages', () => {
  it('normalise la date de résolution en ISO quand elle existe', async () => {
    const resolu = setup({
      repo: {
        findById: vi
          .fn()
          .mockResolvedValue(ligne({ status: 'resolu', resolved_at: '2026-03-01 08:30:00' })),
      },
    });

    expect((await resolu.service.get(ID_RETOUR, TRIEUR)).resolvedAt).toMatch(
      /^2026-03-01T\d{2}:30:00/,
    );
  });

  it('rend null quand le retour n’est pas résolu', async () => {
    expect((await t.service.get(ID_RETOUR, TRIEUR)).resolvedAt).toBeNull();
  });
});

describe('lecture du contexte', () => {
  it('lit un contexte qu’il vienne d’un objet ou de son texte', async () => {
    const texte = setup({
      repo: {
        findById: vi
          .fn()
          .mockResolvedValue(
            ligne({ context: '{"route":"/analyse","targetUrl":null,"gamme":null}' }),
          ),
      },
    });

    expect((await texte.service.get(ID_RETOUR, TRIEUR)).context.route).toBe('/analyse');
  });

  it('retombe sur un contexte VIDE plutôt que d’échouer', async () => {
    // Un retour sans contexte reste un retour.
    for (const brut of ['pas du json', '[1,2]', null, 42]) {
      const casse = setup({
        repo: { findById: vi.fn().mockResolvedValue(ligne({ context: brut })) },
      });
      expect((await casse.service.get(ID_RETOUR, TRIEUR)).context).toEqual({
        route: null,
        targetUrl: null,
        gamme: null,
      });
    }
  });

  it('ÉCARTE un champ de contexte d’un type inattendu', async () => {
    const mixte = setup({
      repo: { findById: vi.fn().mockResolvedValue(ligne({ context: { route: 42, gamme: 'a' } })) },
    });

    expect((await mixte.service.get(ID_RETOUR, TRIEUR)).context).toEqual({
      route: null,
      targetUrl: null,
      gamme: 'a',
    });
  });
});
