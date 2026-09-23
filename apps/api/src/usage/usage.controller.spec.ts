import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { UsageController } from './usage.controller.js';
import type { UsageService } from './usage.service.js';

function build() {
  const usage = {
    overview: vi.fn().mockResolvedValue({ periode: '30j' }),
    governance: vi.fn().mockResolvedValue({ collecteDediee: false }),
  };
  return { usage, controller: new UsageController(usage as unknown as UsageService) };
}

describe('UsageController', () => {
  const reflector = new Reflector();
  const routes = ['overview', 'governance'] as const;

  describe('gardes de route', () => {
    it('exige `usage:read` sur les DEUX routes', () => {
      // Le registre de traitement dit ce que l'application conserve : cela ne
      // regarde pas tous les comptes.
      for (const route of routes) {
        expect(reflector.get(PERMISSIONS_KEY, UsageController.prototype[route])).toBe(
          PERMISSIONS.USAGE_READ,
        );
      }
    });

    it('n’exige AUCUN rang minimal', () => {
      // La permission suffit, et elle reste accordable à un rang inférieur.
      for (const route of routes) {
        expect(reflector.get(MIN_RANK_KEY, UsageController.prototype[route])).toBeUndefined();
      }
    });

    it('n’expose aucune route en dehors de ces deux LECTURES', () => {
      // Une méthode ajoutée plus tard sans garde ferait tomber ce test, et
      // c'est le but.
      const declarees = Object.getOwnPropertyNames(UsageController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (UsageController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });

      expect(declarees.sort()).toEqual([...routes].sort());
    });

    it('n’offre AUCUN déclenchement de l’anonymisation', () => {
      // Ce serait une porte vers la seule opération capable de modifier le
      // journal d'audit : la seule façon de la lancer reste le minuteur.
      const noms = Object.getOwnPropertyNames(UsageController.prototype);

      expect(noms).not.toContain('anonymize');
      expect(noms).not.toContain('anonymiser');
      expect(noms).not.toContain('purge');
      expect(noms).not.toContain('run');
    });
  });

  describe('délégation', () => {
    it('transmet la période demandée', async () => {
      const t = build();
      await t.controller.overview({ periode: '7j' });

      expect(t.usage.overview).toHaveBeenCalledWith('7j');
    });

    it('lit la gouvernance sans paramètre', async () => {
      const t = build();
      await t.controller.governance();

      expect(t.usage.governance).toHaveBeenCalledWith();
    });
  });
});
