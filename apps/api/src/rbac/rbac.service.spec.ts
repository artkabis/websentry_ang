import { PERMISSIONS, RANKS } from '@websentry/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  PermissionRepository,
  PermissionRow,
} from '../database/repositories/permission.repository.js';
import { RbacService } from './rbac.service.js';

function row(permission: string, gammes: unknown): PermissionRow {
  return {
    permission,
    gammes,
    granted_by: 'admin-1',
    granted_at: '2026-01-01 00:00:00',
    expires_at: null,
  } as unknown as PermissionRow;
}

describe('RbacService', () => {
  let repo: { findOne: ReturnType<typeof vi.fn>; findAllForUser: ReturnType<typeof vi.fn> };
  let service: RbacService;

  beforeEach(() => {
    repo = { findOne: vi.fn(), findAllForUser: vi.fn() };
    service = new RbacService(repo as unknown as PermissionRepository);
  });

  describe('seuils de rang', () => {
    it('reconnaît le super_admin', () => {
      expect(service.isSuperAdmin(RANKS.SUPER_ADMIN)).toBe(true);
      expect(service.isSuperAdmin(RANKS.ADMIN)).toBe(false);
    });

    it('reconnaît l’admin, super_admin inclus', () => {
      expect(service.isAdmin(RANKS.ADMIN)).toBe(true);
      expect(service.isAdmin(RANKS.SUPER_ADMIN)).toBe(true);
      expect(service.isAdmin(RANKS.EDITOR)).toBe(false);
    });
  });

  describe('défauts par rang', () => {
    it('accorde toutes les permissions au super_admin', () => {
      const perms = service.defaultsForRank(RANKS.SUPER_ADMIN);
      expect(perms).toContain(PERMISSIONS.AUDIT_READ);
      expect(perms).toContain(PERMISSIONS.USERS_DELETE);
    });

    it('n’accorde PAS audit:read à l’admin — réservé au rang 100', () => {
      expect(service.defaultsForRank(RANKS.ADMIN)).not.toContain(PERMISSIONS.AUDIT_READ);
    });

    it('n’accorde PAS history:read au tester — il ne voit que ses propres scans', () => {
      expect(service.defaultsForRank(RANKS.TESTER)).not.toContain(PERMISSIONS.HISTORY_READ);
      expect(service.defaultsForRank(RANKS.TESTER)).toContain(PERMISSIONS.SCAN_RUN);
    });

    it('reflète les défauts via rankGrants', () => {
      expect(service.rankGrants(RANKS.ADMIN, PERMISSIONS.USERS_WRITE)).toBe(true);
      expect(service.rankGrants(RANKS.TESTER, PERMISSIONS.USERS_WRITE)).toBe(false);
    });
  });

  describe('resolve', () => {
    it('accorde tout au super_admin SANS interroger la base', async () => {
      // Le compte de dernier recours ne doit pas pouvoir être enfermé dehors par
      // une base en panne.
      await expect(
        service.resolve('u1', RANKS.SUPER_ADMIN, PERMISSIONS.USERS_DELETE),
      ).resolves.toEqual({ gammes: null });
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('accorde la permission trouvée en base, avec son scope', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, ['premium', 'essentiel']));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: ['premium', 'essentiel'],
      });
    });

    it('accorde un scope ouvert quand la colonne gammes est NULL', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, null));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: null,
      });
    });

    it('se replie sur les défauts du rang quand aucune ligne n’existe', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.resolve('u1', RANKS.ADMIN, PERMISSIONS.USERS_WRITE)).resolves.toEqual({
        gammes: null,
      });
    });

    it('refuse quand ni la base ni le rang n’accordent le code', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_DELETE),
      ).resolves.toBeNull();
    });

    it('propage une panne de base — le refus n’est pas silencieux', async () => {
      repo.findOne.mockRejectedValue(new Error('connexion perdue'));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).rejects.toThrow();
    });
  });

  describe('normalisation de la colonne JSON gammes', () => {
    it('décode une chaîne JSON', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, '["premium"]'));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: ['premium'],
      });
    });

    it('accepte un tableau déjà décodé par le driver', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, ['premium']));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: ['premium'],
      });
    });

    it('convertit en chaînes les éléments non textuels', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, [1, true]));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: ['1', 'true'],
      });
    });

    it('retombe sur un scope ouvert face à un JSON illisible', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, '{pas du json}'));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: null,
      });
    });

    it('retombe sur un scope ouvert face à un JSON valide mais non tableau', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, '{"a":1}'));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: null,
      });
    });

    it('retombe sur un scope ouvert face à un type inattendu', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, 42));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: null,
      });
    });

    it('retombe sur un scope ouvert quand la colonne vaut undefined', async () => {
      repo.findOne.mockResolvedValue(row(PERMISSIONS.USERS_READ, undefined));
      await expect(service.resolve('u1', RANKS.TESTER, PERMISSIONS.USERS_READ)).resolves.toEqual({
        gammes: null,
      });
    });
  });

  describe('gammeInScope', () => {
    it('autorise quand aucune gamme n’est demandée', () => {
      expect(service.gammeInScope(['premium'], null)).toBe(true);
      expect(service.gammeInScope(['premium'], undefined)).toBe(true);
      expect(service.gammeInScope(['premium'], '')).toBe(true);
    });

    it('autorise tout quand le scope est ouvert', () => {
      expect(service.gammeInScope(null, 'nimporte')).toBe(true);
    });

    it('autorise une gamme du scope, sans distinction de casse', () => {
      expect(service.gammeInScope(['Premium'], 'premium')).toBe(true);
      expect(service.gammeInScope(['premium'], 'PREMIUM')).toBe(true);
    });

    it('refuse une gamme hors scope', () => {
      expect(service.gammeInScope(['premium'], 'essentiel')).toBe(false);
    });

    it('refuse tout quand le scope est un tableau vide', () => {
      expect(service.gammeInScope([], 'premium')).toBe(false);
    });
  });

  describe('listForUser', () => {
    it('projette les lignes en permissions exposables au front', async () => {
      repo.findAllForUser.mockResolvedValue([
        row(PERMISSIONS.USERS_READ, ['premium']),
        row(PERMISSIONS.DOCS_READ, null),
      ]);

      await expect(service.listForUser('u1')).resolves.toEqual([
        { permission: PERMISSIONS.USERS_READ, gammes: ['premium'] },
        { permission: PERMISSIONS.DOCS_READ, gammes: null },
      ]);
    });

    it('retourne une liste vide quand l’utilisateur n’a aucun grant', async () => {
      repo.findAllForUser.mockResolvedValue([]);
      await expect(service.listForUser('u1')).resolves.toEqual([]);
    });
  });
});
