import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, ScanSearchQuerySchema } from '@websentry/shared';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ScansController } from './scans.controller.js';
import type { ScansService } from './scans.service.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const PAGE_A = '33333333-3333-4333-8333-333333333333';

const ADMIN: AuthUser = { sub: 'u1', username: 'alice', rank: 50, version: 0 };
const TESTER: AuthUser = { sub: 'u2', username: 'bob', rank: 10, version: 0 };

function req(): AuthenticatedRequest {
  return { ip: '203.0.113.10', headers: {}, cookies: {} } as AuthenticatedRequest;
}

function build() {
  const scans = {
    searchPages: vi.fn().mockResolvedValue({ total: 0, page: 1, limit: 20, pages: 0, scans: [] }),
    listSites: vi.fn().mockResolvedValue({ total: 0, page: 1, limit: 20, pages: 0, sites: [] }),
    listSiteSessions: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ total: 0 }),
    getPageReport: vi.fn().mockResolvedValue({ scan: {}, report: {} }),
    getSessionReport: vi.fn().mockResolvedValue({ sessionId: SESSION_A }),
    getOwnSessionReport: vi.fn().mockResolvedValue({ sessionId: SESSION_A }),
    compareSessions: vi.fn().mockResolvedValue({ summary: {} }),
    deletePages: vi.fn().mockResolvedValue(3),
    deleteSite: vi.fn().mockResolvedValue(12),
    deleteDomain: vi.fn().mockResolvedValue(40),
    deleteSession: vi.fn().mockResolvedValue(5),
  };
  return { controller: new ScansController(scans as unknown as ScansService), scans };
}

/** Permission exigée par une méthode, telle que la garde globale la lira. */
function permissionOf(method: keyof ScansController): string | undefined {
  return Reflect.getMetadata(PERMISSIONS_KEY, ScansController.prototype[method]) as
    string | undefined;
}

describe('ScansController', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('contrôle d’accès', () => {
    it.each([
      'search',
      'listSites',
      'listSiteSessions',
      'stats',
      'getSession',
      'compare',
      'getPage',
    ] as const)('exige history:read pour %s', method => {
      expect(permissionOf(method)).toBe(PERMISSIONS.HISTORY_READ);
    });

    it.each(['deletePages', 'deleteSite', 'deleteSession', 'deleteDomain'] as const)(
      'exige history:delete pour %s',
      method => {
        expect(permissionOf(method)).toBe(PERMISSIONS.HISTORY_DELETE);
      },
    );

    it('N’EXIGE aucune permission pour la lecture de ses propres scans', () => {
      // C'est la seule route de l'historique ouverte au rang testeur : sans
      // elle, il ne pourrait pas revoir son propre audit de la veille.
      expect(permissionOf('getOwnSession')).toBeUndefined();
      expect(
        Reflect.getMetadata(MIN_RANK_KEY, ScansController.prototype.getOwnSession),
      ).toBeUndefined();
    });

    it('ne pose AUCUNE route d’écriture de l’historique', () => {
      // Un endpoint d'ingestion offrirait à un jeton volé le moyen de fabriquer
      // un passé dans une base dont l'objet est de faire foi.
      const methods = Object.getOwnPropertyNames(ScansController.prototype);
      expect(methods).not.toContain('record');
      expect(methods).not.toContain('ingest');
    });
  });

  describe('lecture', () => {
    it('transmet la requête de recherche validée', async () => {
      const query = ScanSearchQuerySchema.parse({ domain: 'exemple.fr', page: '2' });
      await t.controller.search(query);
      expect(t.scans.searchPages).toHaveBeenCalledWith(query);
    });

    it('transmet la sélection de site', async () => {
      await t.controller.listSiteSessions({ domain: 'exemple.fr', gamme: null });
      expect(t.scans.listSiteSessions).toHaveBeenCalledWith('exemple.fr', null);
    });

    it('transmet la requête à la vue par site', async () => {
      const query = ScanSearchQuerySchema.parse({ sort: 'score', order: 'asc' });
      await t.controller.listSites(query);
      expect(t.scans.listSites).toHaveBeenCalledWith(query);
    });

    it('sert le détail d’une session', async () => {
      await expect(t.controller.getSession(SESSION_A)).resolves.toMatchObject({
        sessionId: SESSION_A,
      });
      expect(t.scans.getSessionReport).toHaveBeenCalledWith(SESSION_A);
    });

    it('sert le rapport complet d’une page', async () => {
      await t.controller.getPage(PAGE_A);
      expect(t.scans.getPageReport).toHaveBeenCalledWith(PAGE_A);
    });

    it('sert les statistiques', async () => {
      await t.controller.stats();
      expect(t.scans.getStats).toHaveBeenCalled();
    });

    it('transmet les deux identifiants de comparaison dans l’ordre reçu', async () => {
      await t.controller.compare(SESSION_A, SESSION_B);
      expect(t.scans.compareSessions).toHaveBeenCalledWith(SESSION_A, SESSION_B);
    });
  });

  describe('scans personnels', () => {
    it('transmet le nom d’utilisateur et le statut d’administrateur', async () => {
      await t.controller.getOwnSession(SESSION_A, ADMIN);
      expect(t.scans.getOwnSessionReport).toHaveBeenCalledWith(SESSION_A, 'alice', true);
    });

    it('marque un testeur comme non-administrateur', async () => {
      await t.controller.getOwnSession(SESSION_A, TESTER);
      expect(t.scans.getOwnSessionReport).toHaveBeenCalledWith(SESSION_A, 'bob', false);
    });
  });

  describe('suppression', () => {
    it('rend le nombre supprimé et journalise l’auteur', async () => {
      const result = await t.controller.deletePages({ ids: [PAGE_A] }, req(), ADMIN);
      expect(result).toEqual({ deleted: 3 });
      expect(t.scans.deletePages).toHaveBeenCalledWith([PAGE_A], {
        actorId: 'u1',
        actorName: 'alice',
        ipAddress: '203.0.113.10',
      });
    });

    it('accepte une requête sans adresse IP résolue', async () => {
      // Derrière certains répartiteurs, `ip` peut manquer : le journal d'audit
      // doit rester écrit, avec un champ nul plutôt qu'« undefined ».
      const anonymous = { headers: {}, cookies: {} } as AuthenticatedRequest;
      await t.controller.deletePages({ ids: [PAGE_A] }, anonymous, ADMIN);
      expect(t.scans.deletePages).toHaveBeenCalledWith(
        [PAGE_A],
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('transmet la gamme nulle telle quelle', async () => {
      // `null` désigne le site SANS gamme, pas « toutes les gammes ».
      await t.controller.deleteSite({ domain: 'exemple.fr', gamme: null }, req(), ADMIN);
      expect(t.scans.deleteSite).toHaveBeenCalledWith('exemple.fr', null, expect.anything());
    });

    it('supprime une session', async () => {
      await expect(t.controller.deleteSession(SESSION_A, req(), ADMIN)).resolves.toEqual({
        deleted: 5,
      });
    });

    it('supprime un domaine entier', async () => {
      await expect(t.controller.deleteDomain('exemple.fr', req(), ADMIN)).resolves.toEqual({
        deleted: 40,
      });
    });
  });
});
