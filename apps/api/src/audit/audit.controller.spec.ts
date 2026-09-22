import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { RANKS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { AuditController } from './audit.controller.js';
import type { AuditService } from './audit.service.js';

function build() {
  const audit = { list: vi.fn().mockResolvedValue({ entries: [], total: 0 }) };
  return { controller: new AuditController(audit as unknown as AuditService), audit };
}

describe('AuditController', () => {
  const reflector = new Reflector();

  it('RÉSERVE la lecture au rang 100', () => {
    // Le journal porte des adresses IP et le détail des actions sur les
    // comptes : c'est une pièce d'enquête, pas une donnée d'exploitation.
    expect(reflector.get(MIN_RANK_KEY, AuditController.prototype.list)).toBe(RANKS.SUPER_ADMIN);
  });

  it('ne s’appuie PAS sur une permission fine', () => {
    // `audit:read` existe au catalogue mais reste réservé : une garde par
    // permission laisserait croire qu'on peut le déléguer.
    expect(reflector.get(PERMISSIONS_KEY, AuditController.prototype.list)).toBeUndefined();
  });

  it('n’expose AUCUNE route en dehors de la lecture', () => {
    // Le journal est append-only : pas de purge, pas de correction.
    const routes = Object.getOwnPropertyNames(AuditController.prototype).filter(nom => {
      if (nom === 'constructor') return false;
      const membre = (AuditController.prototype as unknown as Record<string, unknown>)[nom];
      return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
    });

    expect(routes).toEqual(['list']);
  });

  it('transmet la requête validée au service', () => {
    const t = build();
    void t.controller.list({ limit: 25, offset: 50, actor: 'alice' });
    expect(t.audit.list).toHaveBeenCalledWith({ limit: 25, offset: 50, actor: 'alice' });
  });
});
