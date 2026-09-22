import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';
import { SupervisionController } from './supervision.controller.js';
import type { SupervisionService } from './supervision.service.js';

describe('SupervisionController', () => {
  const reflector = new Reflector();

  it('exige health:read — une donnée d’EXPLOITATION, pas une enquête', () => {
    // Le rang administrateur la détient par défaut : qui pilote l'outil doit
    // pouvoir constater qu'un pool est tombé sans attendre le rang 100.
    expect(reflector.get(PERMISSIONS_KEY, SupervisionController.prototype.releve)).toBe(
      PERMISSIONS.HEALTH_READ,
    );
  });

  it('n’est JAMAIS publique', () => {
    // La sonde publique `/health` reste pauvre ; celle-ci décrit
    // l'infrastructure et serait un outil de reconnaissance (OWASP #7).
    expect(reflector.get(IS_PUBLIC_KEY, SupervisionController.prototype.releve)).toBeUndefined();
  });

  it('ne s’appuie PAS sur un rang, pour ne pas la réserver au sommet', () => {
    expect(reflector.get(MIN_RANK_KEY, SupervisionController.prototype.releve)).toBeUndefined();
  });

  it('n’expose QUE la lecture — aucune commande d’exploitation', () => {
    // Redémarrer un pool ou forcer une purge depuis une page web serait une
    // surface d'attaque pour un gain nul : ces gestes vivent côté opérateur.
    const routes = Object.getOwnPropertyNames(SupervisionController.prototype).filter(nom => {
      if (nom === 'constructor') return false;
      const membre = (SupervisionController.prototype as unknown as Record<string, unknown>)[nom];
      return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
    });

    expect(routes).toEqual(['releve']);
  });

  it('délègue le relevé au service', () => {
    const supervision = { releve: vi.fn().mockResolvedValue({ etat: 'ok' }) };
    const controller = new SupervisionController(supervision as unknown as SupervisionService);

    void controller.releve();
    expect(supervision.releve).toHaveBeenCalled();
  });
});
