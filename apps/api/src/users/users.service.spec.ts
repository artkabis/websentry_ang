import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RANKS } from '@websentry/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { SessionRepository } from '../database/repositories/session.repository.js';
import type {
  AdminUserRow,
  UserAdminRepository,
} from '../database/repositories/user-admin.repository.js';
import type { UserRepository } from '../database/repositories/user.repository.js';
import { PasswordService } from '../security/password.service.js';
import { UsersService, type Actor } from './users.service.js';

const ID_CIBLE = '22222222-2222-4222-8222-222222222222';
const ID_ACTEUR = '11111111-1111-4111-8111-111111111111';

/**
 * Champs d'un compte, sans l'héritage `RowDataPacket` de mysql2.
 *
 * `Partial<AdminUserRow>` est inutilisable ici : l'interface hérite d'un
 * `constructor.name` littéral que jamais un objet de test ne portera.
 */
type ChampsCompte = Pick<
  AdminUserRow,
  | 'id'
  | 'username'
  | 'display_name'
  | 'email'
  | 'rank'
  | 'status'
  | 'locked_until'
  | 'total_scans_launched'
  | 'created_at'
  | 'updated_at'
>;

function ligne(over: Partial<ChampsCompte> = {}): AdminUserRow {
  return {
    id: ID_CIBLE,
    username: 'bob',
    display_name: null,
    email: null,
    rank: RANKS.TESTER,
    status: 'active',
    locked_until: null,
    total_scans_launched: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...over,
  } as AdminUserRow;
}

const ADMIN: Actor = {
  id: ID_ACTEUR,
  username: 'alice',
  rank: RANKS.ADMIN,
  ipAddress: '203.0.113.7',
};

/** Surcharges des doubles — objets simples : ce sont des mocks, pas des dépôts. */
interface Surcharges {
  admin?: Record<string, unknown>;
  users?: Record<string, unknown>;
}

function setup(over: Surcharges = {}) {
  const admin = {
    available: true,
    list: vi.fn().mockResolvedValue([ligne()]),
    count: vi.fn().mockResolvedValue(1),
    findById: vi.fn().mockResolvedValue(ligne()),
    countActiveAtLeastRank: vi.fn().mockResolvedValue(5),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    updatePassword: vi.fn().mockResolvedValue(1),
    delete: vi.fn().mockResolvedValue(1),
    list_permissions: vi.fn().mockResolvedValue([]),
    grantPermission: vi.fn().mockResolvedValue(undefined),
    revokePermission: vi.fn().mockResolvedValue(1),
    ...over.admin,
  } as unknown as UserAdminRepository;

  const users = {
    findByUsername: vi.fn().mockResolvedValue(null),
    bumpTokenVersion: vi.fn().mockResolvedValue(undefined),
    ...over.users,
  } as unknown as UserRepository;

  const sessions = {
    revokeAllForUser: vi.fn().mockResolvedValue(2),
  } as unknown as SessionRepository;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  return {
    admin,
    users,
    sessions,
    audit,
    service: new UsersService(admin, users, sessions, new PasswordService(), audit),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('sans base de données', () => {
  it('REFUSE clairement plutôt qu’à moitié', async () => {
    // Le mode sans base porte deux comptes de développement dans un fichier ;
    // les administrer par l'API donnerait une seconde façon de les écrire.
    const sansBase = setup({ admin: { available: false } });

    await expect(sansBase.service.list({ limit: 50, offset: 0 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('lecture', () => {
  it('rend la page ET le total, filtres compris', async () => {
    // Sans le total, l'interface ne sait pas quoi annoncer ni quand s'arrêter.
    const reponse = await t.service.list({ limit: 10, offset: 20, search: 'bo', status: 'active' });

    expect(reponse.total).toBe(1);
    expect(t.admin.list).toHaveBeenCalledWith(
      { search: 'bo', rank: undefined, status: 'active' },
      10,
      20,
    );
  });

  it('N’EXPOSE PAS l’empreinte du mot de passe', async () => {
    const compte = await t.service.get(ID_CIBLE);

    expect(compte).not.toHaveProperty('password_hash');
    expect(compte).not.toHaveProperty('passwordHash');
    expect(compte.role).toBe('tester');
  });

  it('dit « introuvable » plutôt que de rendre un objet vide', async () => {
    const absent = setup({ admin: { findById: vi.fn().mockResolvedValue(null) } });

    await expect(absent.service.get(ID_CIBLE)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('création', () => {
  const NOUVEAU = { username: 'carol', password: 'a'.repeat(12), rank: RANKS.TESTER };

  it('crée un compte et le trace', async () => {
    await t.service.create(NOUVEAU, ADMIN);

    expect(t.admin.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'carol', rank: RANKS.TESTER, createdBy: ID_ACTEUR }),
    );
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.create', targetType: 'user' }),
    );
  });

  it('HACHE le mot de passe — il n’atteint jamais la base en clair', async () => {
    await t.service.create(NOUVEAU, ADMIN);

    const envoye = vi.mocked(t.admin.create).mock.calls[0]?.[0];
    expect(envoye?.passwordHash).not.toContain(NOUVEAU.password);
    expect(await new PasswordService().verify(NOUVEAU.password, envoye!.passwordHash)).toBe(true);
  });

  it('REFUSE de créer au-dessus de son propre rang', async () => {
    // Sans cette règle, un administrateur se fabrique un super_admin et
    // devient super_admin.
    await expect(
      t.service.create({ ...NOUVEAU, rank: RANKS.SUPER_ADMIN }, ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.admin.create).not.toHaveBeenCalled();
  });

  it('REFUSE de créer à son propre rang', async () => {
    await expect(t.service.create({ ...NOUVEAU, rank: RANKS.ADMIN }, ADMIN)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('laisse le super_admin créer un pair', async () => {
    const racine = setup();

    await racine.service.create(
      { ...NOUVEAU, rank: RANKS.SUPER_ADMIN },
      { ...ADMIN, rank: RANKS.SUPER_ADMIN },
    );

    expect(racine.admin.create).toHaveBeenCalled();
  });

  it('REFUSE un identifiant déjà pris', async () => {
    const pris = setup({
      users: { findByUsername: vi.fn().mockResolvedValue({ id: 'autre' }) },
    });

    await expect(pris.service.create(NOUVEAU, ADMIN)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('modification', () => {
  it('RÉVOQUE les jetons quand le rang change', async () => {
    // Sans cela, un compte rétrogradé garde ses droits jusqu'à l'expiration
    // de son jeton d'accès.
    await t.service.update(ID_CIBLE, { rank: RANKS.EDITOR }, ADMIN);

    expect(t.users.bumpTokenVersion).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('RÉVOQUE les sessions d’un compte suspendu', async () => {
    await t.service.update(ID_CIBLE, { status: 'suspended' }, ADMIN);

    expect(t.sessions.revokeAllForUser).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('ne révoque RIEN pour un simple changement de nom', async () => {
    // Déconnecter quelqu'un parce qu'on a corrigé son courriel serait une
    // punition sans faute.
    await t.service.update(ID_CIBLE, { displayName: 'Bob Martin' }, ADMIN);

    expect(t.users.bumpTokenVersion).not.toHaveBeenCalled();
    expect(t.sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('REFUSE de changer son PROPRE rang', async () => {
    // C'est ainsi qu'on s'élève en deux temps, ou qu'on s'enferme dehors.
    const soi = setup({ admin: { findById: vi.fn().mockResolvedValue(ligne({ id: ID_ACTEUR })) } });

    await expect(
      soi.service.update(ID_ACTEUR, { rank: RANKS.SUPER_ADMIN }, ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('REFUSE à un super_admin de changer son PROPRE statut', async () => {
    // Le cas précédent passe aussi par le garde-fou de rang (cible de rang
    // égal) : seul le super_admin, que ce garde-fou laisse passer, prouve que
    // l'interdiction de se modifier soi-même existe bien pour elle-même.
    const patron = { ...ADMIN, rank: RANKS.SUPER_ADMIN };
    const soi = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ id: ID_ACTEUR, rank: RANKS.SUPER_ADMIN })),
      },
    });

    await expect(
      soi.service.update(ID_ACTEUR, { status: 'suspended' }, patron),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('REFUSE de RÉTROGRADER le dernier administrateur actif', async () => {
    // Suspendre n'est pas la seule façon de vider l'instance de ses
    // administrateurs : rétrograder produit exactement le même résultat.
    const dernier = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.ADMIN, status: 'active' })),
        countActiveAtLeastRank: vi.fn().mockResolvedValue(1),
      },
    });

    await expect(
      dernier.service.update(
        ID_CIBLE,
        { rank: RANKS.EDITOR },
        { ...ADMIN, rank: RANKS.SUPER_ADMIN },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSE de toucher à un compte de rang supérieur', async () => {
    const patron = setup({
      admin: { findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.SUPER_ADMIN })) },
    });

    await expect(
      patron.service.update(ID_CIBLE, { status: 'suspended' }, ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('REFUSE de retirer le DERNIER administrateur actif', async () => {
    // Une instance sans administrateur actif ne se reprend pas en main depuis
    // l'interface : il faudrait rouvrir la base à la main.
    const dernier = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.ADMIN, status: 'active' })),
        countActiveAtLeastRank: vi.fn().mockResolvedValue(1),
      },
    });

    await expect(
      dernier.service.update(
        ID_CIBLE,
        { status: 'suspended' },
        { ...ADMIN, rank: RANKS.SUPER_ADMIN },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepte de rétrograder un administrateur s’il en reste d’autres', async () => {
    const plusieurs = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.ADMIN })),
        countActiveAtLeastRank: vi.fn().mockResolvedValue(3),
      },
    });

    await plusieurs.service.update(
      ID_CIBLE,
      { rank: RANKS.TESTER },
      { ...ADMIN, rank: RANKS.SUPER_ADMIN },
    );

    expect(plusieurs.admin.update).toHaveBeenCalled();
  });
});

describe('réinitialisation du mot de passe', () => {
  it('révoque les sessions ouvertes avec l’ancien', async () => {
    await t.service.resetPassword(ID_CIBLE, 'b'.repeat(12), ADMIN);

    expect(t.sessions.revokeAllForUser).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('N’ÉCRIT PAS le mot de passe dans le journal d’audit', async () => {
    // Un journal se lit plus facilement qu'une table de comptes.
    const motDePasse = 'SecretDeAlice42';

    await t.service.resetPassword(ID_CIBLE, motDePasse, ADMIN);

    const trace = JSON.stringify(vi.mocked(t.audit.record).mock.calls[0]?.[0]);
    expect(trace).not.toContain(motDePasse);
    expect(trace).toContain('user.password_reset');
  });

  it('REFUSE de réinitialiser celui d’un rang supérieur', async () => {
    const patron = setup({
      admin: { findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.SUPER_ADMIN })) },
    });

    await expect(
      patron.service.resetPassword(ID_CIBLE, 'b'.repeat(12), ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('suppression', () => {
  it('révoque les sessions AVANT de supprimer', async () => {
    await t.service.remove(ID_CIBLE, ADMIN);

    expect(t.sessions.revokeAllForUser).toHaveBeenCalledWith(ID_CIBLE);
    expect(t.admin.delete).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('REFUSE de se supprimer soi-même', async () => {
    const soi = setup({ admin: { findById: vi.fn().mockResolvedValue(ligne({ id: ID_ACTEUR })) } });

    await expect(soi.service.remove(ID_ACTEUR, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(soi.admin.delete).not.toHaveBeenCalled();
  });

  it('REFUSE de supprimer le dernier administrateur', async () => {
    const dernier = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ rank: RANKS.ADMIN })),
        countActiveAtLeastRank: vi.fn().mockResolvedValue(1),
      },
    });

    await expect(
      dernier.service.remove(ID_CIBLE, { ...ADMIN, rank: RANKS.SUPER_ADMIN }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('permissions fines', () => {
  it('REFUSE de déléguer ce qu’on ne détient pas', async () => {
    // Déléguer au-delà de son rang reviendrait à le contourner par personne
    // interposée.
    await expect(
      t.service.grantPermission(
        ID_CIBLE,
        { permission: 'users:delete', gammes: null, expiresAt: null },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accorde ce que l’acteur détient, et révoque les jetons de la cible', async () => {
    // Les droits changent : le jeton en cours porte encore les anciens.
    await t.service.grantPermission(
      ID_CIBLE,
      { permission: 'scan:run', gammes: ['premium'], expiresAt: null },
      ADMIN,
    );

    expect(t.admin.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: 'scan:run',
        gammes: ['premium'],
        grantedBy: ID_ACTEUR,
      }),
    );
    expect(t.users.bumpTokenVersion).toHaveBeenCalledWith(ID_CIBLE);
  });

  it('laisse le super_admin tout déléguer', async () => {
    const racine = setup();

    await racine.service.grantPermission(
      ID_CIBLE,
      { permission: 'users:delete', gammes: null, expiresAt: null },
      { ...ADMIN, rank: RANKS.SUPER_ADMIN },
    );

    expect(racine.admin.grantPermission).toHaveBeenCalled();
  });

  it('signale une révocation qui ne portait sur rien', async () => {
    const rien = setup({ admin: { revokePermission: vi.fn().mockResolvedValue(0) } });

    await expect(rien.service.revokePermission(ID_CIBLE, 'scan:run', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lit les gammes qu’elles viennent d’un tableau ou de son texte', async () => {
    // Selon le pilote et la version, une colonne JSON revient déjà analysée
    // ou sous forme de chaîne.
    const mixte = setup({
      admin: {
        list_permissions: vi.fn().mockResolvedValue([
          {
            permission: 'scan:run',
            gammes: ['a'],
            granted_by: null,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
          {
            permission: 'scan:batch',
            gammes: '["b"]',
            granted_by: ID_ACTEUR,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: '2026-06-01T00:00:00.000Z',
          },
          {
            permission: 'history:read',
            gammes: null,
            granted_by: null,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
        ]),
      },
    });

    const lues = await mixte.service.listPermissions(ID_CIBLE);

    expect(lues.map(p => p.gammes)).toEqual([['a'], ['b'], null]);
    expect(lues[1]?.expiresAt).toBe('2026-06-01T00:00:00.000Z');
  });
  it('RÉVOQUE et invalide les jetons du compte visé', async () => {
    // Sans révocation, la permission retirée continue de valoir jusqu'à
    // l'expiration du jeton qui la portait.
    await t.service.revokePermission(ID_CIBLE, 'scan:run', ADMIN);

    expect(t.users.bumpTokenVersion).toHaveBeenCalledWith(ID_CIBLE);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.permission_revoke' }),
    );
  });

  it('convertit une échéance ISO en date pour la base', async () => {
    await t.service.grantPermission(
      ID_CIBLE,
      { permission: 'scan:run', gammes: null, expiresAt: '2027-01-01T00:00:00.000Z' },
      ADMIN,
    );

    const [octroi] = vi.mocked(t.admin.grantPermission).mock.calls[0] ?? [];
    expect(octroi?.expiresAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('ÉCARTE les gammes d’un type inattendu plutôt que de les convertir', async () => {
    // Un élément non textuel signale une colonne corrompue : le rendre en
    // texte masquerait le problème derrière une valeur plausible.
    const corrompu = setup({
      admin: {
        list_permissions: vi.fn().mockResolvedValue([
          {
            permission: 'scan:run',
            gammes: '["ok", 42, null]',
            granted_by: null,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
          {
            permission: 'scan:batch',
            gammes: 'ceci-n-est-pas-du-json',
            granted_by: null,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
          {
            permission: 'history:read',
            gammes: '{"pas": "un tableau"}',
            granted_by: null,
            granted_at: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
        ]),
      },
    });

    expect((await corrompu.service.listPermissions(ID_CIBLE)).map(p => p.gammes)).toEqual([
      ['ok'],
      null,
      null,
    ]);
  });

  it('rend le verrou temporaire en ISO quand il y en a un', async () => {
    const verrouille = setup({
      admin: {
        findById: vi.fn().mockResolvedValue(ligne({ locked_until: '2026-03-01T10:00:00.000Z' })),
      },
    });

    expect((await verrouille.service.get(ID_CIBLE)).lockedUntil).toBe('2026-03-01T10:00:00.000Z');
  });
});
