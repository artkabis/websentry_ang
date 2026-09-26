import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { ScanTrashController } from './scan-trash.controller.js';
import type { ScanTrashService } from './scan-trash.service.js';
import { ScansController } from './scans.controller.js';
import { ScansModule } from './scans.module.js';

const REQ = { ip: '203.0.113.7' } as never;
const USER = { sub: '11111111-1111-4111-8111-111111111111', username: 'alice' } as never;
const ID = '22222222-2222-4222-8222-222222222222';

function build() {
  const corbeille = {
    lister: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    exporter: vi.fn().mockResolvedValue({ format: 1 }),
    restaurer: vi.fn().mockResolvedValue({ sites: 1, sessions: 1, pages: 2, skippedSessions: 0 }),
    purger: vi.fn().mockResolvedValue(undefined),
  };
  return {
    corbeille,
    controller: new ScanTrashController(corbeille as unknown as ScanTrashService),
  };
}

describe('ScanTrashController', () => {
  const reflector = new Reflector();
  const routes = ['lister', 'exporter', 'restaurer', 'purger'] as const;

  describe('gardes de route', () => {
    it('exige `history:delete` sur les QUATRE routes', () => {
      // Qui peut supprimer peut restaurer ce qu'il a supprimé, et la purge
      // définitive est la même puissance destructrice que la suppression.
      for (const route of routes) {
        expect(reflector.get(PERMISSIONS_KEY, ScanTrashController.prototype[route])).toBe(
          PERMISSIONS.HISTORY_DELETE,
        );
      }
    });

    it('n’exige AUCUN rang minimal', () => {
      // La corbeille se délègue par permission fine, comme la suppression.
      for (const route of routes) {
        expect(reflector.get(MIN_RANK_KEY, ScanTrashController.prototype[route])).toBeUndefined();
      }
    });

    it('n’expose RIEN d’autre que ces quatre routes', () => {
      const declarees = Object.getOwnPropertyNames(ScanTrashController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (ScanTrashController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });

      expect(declarees.sort()).toEqual([...routes].sort());
    });

    it('déclare « export » AVANT toute route par identifiant nu', () => {
      const noms = Object.getOwnPropertyNames(ScanTrashController.prototype);
      expect(noms.indexOf('exporter')).toBeLessThan(noms.indexOf('purger'));
    });
  });

  describe('ordre des contrôleurs du module', () => {
    it('place la CORBEILLE avant l’historique', () => {
      // `GET /scans/:pageId` accepterait « corbeille » comme identifiant de
      // page et servirait un 400 de validation. Nest résout les routes dans
      // l'ordre de déclaration : ce test fixe ce que le commentaire explique.
      const declares = Reflect.getMetadata('controllers', ScansModule) as unknown[];

      expect(declares.indexOf(ScanTrashController)).toBeLessThan(declares.indexOf(ScansController));
    });
  });

  describe('acteur transmis au service', () => {
    it('joint l’identifiant, le nom et l’IP à une restauration', async () => {
      // Sans l'IP, le journal d'audit ne dit pas d'où venait le geste.
      const t = build();

      await t.controller.restaurer(ID, REQ, USER);

      expect(t.corbeille.restaurer).toHaveBeenCalledWith(ID, {
        actorId: '11111111-1111-4111-8111-111111111111',
        actorName: 'alice',
        ipAddress: '203.0.113.7',
      });
    });

    it('accepte une requête SANS adresse IP', async () => {
      const t = build();

      await t.controller.purger(ID, {} as never, USER);

      expect(t.corbeille.purger).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ ipAddress: null }),
      );
    });
  });

  describe('délégation', () => {
    it('passe les filtres de liste tels quels', async () => {
      const t = build();

      await t.controller.lister({ page: 2, limit: 10, scope: 'domain' });

      expect(t.corbeille.lister).toHaveBeenCalledWith({ page: 2, limit: 10, scope: 'domain' });
    });

    it('rend l’export du service', async () => {
      const t = build();

      await expect(t.controller.exporter(ID)).resolves.toEqual({ format: 1 });
    });
  });
});
