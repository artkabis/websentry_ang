import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { DocsController } from './docs.controller.js';
import type { DocsService } from './docs.service.js';

function build() {
  const docs = {
    index: vi.fn().mockReturnValue({ sections: [] }),
    page: vi.fn().mockReturnValue({ slug: 'a' }),
    rechercher: vi.fn().mockReturnValue({ q: 'x', resultats: [], total: 0 }),
  };
  return { docs, controller: new DocsController(docs as unknown as DocsService) };
}

describe('DocsController', () => {
  const reflector = new Reflector();
  const routes = ['index', 'rechercher', 'page'] as const;

  describe('gardes de route', () => {
    it('exige `docs:read` sur les TROIS lectures', () => {
      for (const route of routes) {
        expect(reflector.get(PERMISSIONS_KEY, DocsController.prototype[route])).toBe(
          PERMISSIONS.DOCS_READ,
        );
      }
    });

    it('n’exige AUCUN rang minimal', () => {
      for (const route of routes) {
        expect(reflector.get(MIN_RANK_KEY, DocsController.prototype[route])).toBeUndefined();
      }
    });

    it('n’expose aucune route en dehors de ces trois LECTURES', () => {
      // Les pages vivent dans le dépôt : elles se modifient par une revue de
      // code, pas par une route.
      const declarees = Object.getOwnPropertyNames(DocsController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (DocsController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });

      expect(declarees.sort()).toEqual([...routes].sort());
    });

    it('déclare « recherche » AVANT la route par identifiant', () => {
      // « recherche » est un identifiant valide au regard du schéma : c'est
      // l'ordre de déclaration qui décide laquelle des deux répond.
      const noms = Object.getOwnPropertyNames(DocsController.prototype);
      expect(noms.indexOf('rechercher')).toBeLessThan(noms.indexOf('page'));
    });
  });

  describe('délégation', () => {
    it('relaie le sommaire', () => {
      const t = build();
      t.controller.index();
      expect(t.docs.index).toHaveBeenCalled();
    });

    it('relaie la recherche, terme et limite', () => {
      const t = build();
      t.controller.rechercher({ q: 'scan', limit: 5 });
      expect(t.docs.rechercher).toHaveBeenCalledWith('scan', 5);
    });

    it('relaie l’identifiant de page tel quel', () => {
      const t = build();
      t.controller.page('premiers-pas');
      expect(t.docs.page).toHaveBeenCalledWith('premiers-pas');
    });
  });
});
