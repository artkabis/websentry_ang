import { describe, expect, it, vi } from 'vitest';
import type { AuditRepository } from '../database/repositories/audit.repository.js';
import { AuditService } from './audit.service.js';

function build(available = true) {
  const repo = {
    available,
    append: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
  return { service: new AuditService(repo as unknown as AuditRepository), repo };
}

describe('AuditService', () => {
  describe('record', () => {
    it('transmet l’entrée au repository', async () => {
      const { service, repo } = build();
      await service.record({ actorId: 'u1', actorName: 'alice', action: 'auth.login' });
      expect(repo.append).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login', actorId: 'u1' }),
      );
    });

    it('ne fait rien quand aucune base n’est configurée', async () => {
      const { service, repo } = build(false);
      await service.record({ actorId: null, actorName: null, action: 'auth.login' });
      expect(repo.append).not.toHaveBeenCalled();
    });

    it('n’échoue JAMAIS auprès de l’appelant', async () => {
      // Une base indisponible ne doit pas transformer une connexion réussie en 500.
      const { service, repo } = build();
      repo.append.mockRejectedValue(new Error('base indisponible'));
      await expect(
        service.record({ actorId: 'u1', actorName: 'alice', action: 'auth.login' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('applique les valeurs par défaut de pagination', async () => {
      const { service, repo } = build();
      await service.list();
      expect(repo.list).toHaveBeenCalledWith(50, 0);
    });

    it('plafonne la limite à 200 — pas d’extraction massive', async () => {
      const { service, repo } = build();
      await service.list(100_000, 0);
      expect(repo.list).toHaveBeenCalledWith(200, 0);
    });

    it.each([
      [0, 1],
      [-5, 1],
      [1.9, 1],
    ])('ramène une limite de %s à %s', async (input, expected) => {
      const { service, repo } = build();
      await service.list(input, 0);
      expect(repo.list).toHaveBeenCalledWith(expected, 0);
    });

    it('ramène un décalage négatif à zéro', async () => {
      const { service, repo } = build();
      await service.list(10, -50);
      expect(repo.list).toHaveBeenCalledWith(10, 0);
    });
  });
});
