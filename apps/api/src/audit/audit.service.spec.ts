import { ServiceUnavailableException } from '@nestjs/common';
import type { AuditQuery } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRepository, AuditRow } from '../database/repositories/audit.repository.js';
import { AuditService } from './audit.service.js';

/**
 * Champs d'une trace, sans l'héritage `RowDataPacket` de mysql2.
 *
 * `Partial<AuditRow>` est inutilisable ici : l'interface hérite d'un
 * `constructor.name` littéral que jamais un objet de test ne portera.
 */
type ChampsTrace = Pick<
  AuditRow,
  | 'id'
  | 'actor_id'
  | 'actor_name'
  | 'action'
  | 'target_id'
  | 'target_type'
  | 'details'
  | 'ip_address'
  | 'created_at'
>;

function build(available = true, lignes: Partial<ChampsTrace>[] = []) {
  const repo = {
    available,
    append: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(lignes),
    count: vi.fn().mockResolvedValue(lignes.length),
  };
  return { service: new AuditService(repo as unknown as AuditRepository), repo };
}

/** Requête minimale — le schéma pose ces deux valeurs par défaut. */
function requete(over: Partial<AuditQuery> = {}): AuditQuery {
  return { limit: 50, offset: 0, ...over };
}

function ligne(over: Partial<ChampsTrace> = {}): Partial<ChampsTrace> {
  return {
    id: 1,
    actor_id: 'u-1',
    actor_name: 'alice',
    action: 'user.create',
    target_id: 'u-2',
    target_type: 'user',
    details: { username: 'bob' },
    ip_address: '203.0.113.7',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
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
    it('REFUSE clairement quand aucune base n’est configurée', async () => {
      const { service } = build(false);
      await expect(service.list(requete())).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('rend les entrées ET le total', async () => {
      // Sans le total, l'interface ne sait ni quoi annoncer ni quand s'arrêter.
      const { service, repo } = build(true, [ligne()]);
      repo.count.mockResolvedValue(412);

      const lu = await service.list(requete());
      expect(lu.total).toBe(412);
      expect(lu.entries[0]).toMatchObject({ action: 'user.create', actorName: 'alice' });
    });

    it('transmet les filtres au dépôt', async () => {
      const { service, repo } = build();
      await service.list(
        requete({
          actor: 'alice',
          action: 'user.',
          targetId: 'u-2',
          from: '2026-01-01',
          to: '2026-01-31',
        }),
      );

      expect(repo.list).toHaveBeenCalledWith(50, 0, {
        actor: 'alice',
        action: 'user.',
        targetId: 'u-2',
        from: '2026-01-01',
        to: '2026-01-31',
      });
    });

    it('applique au COMPTAGE exactement les mêmes filtres', async () => {
      // Un total calculé sur un autre filtre annoncerait une pagination fausse.
      const { service, repo } = build();
      await service.list(requete({ actor: 'alice' }));

      const [, , filtresLecture] = repo.list.mock.calls[0] as [number, number, unknown];
      expect(repo.count).toHaveBeenCalledWith(filtresLecture);
    });

    it('plafonne la limite à 200 — pas d’extraction massive', async () => {
      // Le schéma borne déjà, mais un appelant interne ne passe pas par lui.
      const { service, repo } = build();
      await service.list(requete({ limit: 100_000 }));
      expect(repo.list).toHaveBeenCalledWith(200, 0, expect.anything());
    });

    it.each([
      [0, 1],
      [-5, 1],
      [1.9, 1],
    ])('ramène une limite de %s à %s', async (entree, attendu) => {
      const { service, repo } = build();
      await service.list(requete({ limit: entree }));
      expect(repo.list).toHaveBeenCalledWith(attendu, 0, expect.anything());
    });

    it('ramène un décalage négatif à zéro', async () => {
      const { service, repo } = build();
      await service.list(requete({ limit: 10, offset: -50 }));
      expect(repo.list).toHaveBeenCalledWith(10, 0, expect.anything());
    });

    it('lit le détail qu’il vienne d’un objet ou de son texte', async () => {
      // Selon le pilote et la version, une colonne JSON revient déjà analysée
      // ou sous forme de chaîne.
      const { service } = build(true, [
        ligne({ id: 1, details: { a: 1 } }),
        ligne({ id: 2, details: '{"b":2}' as never }),
      ]);

      expect((await service.list(requete())).entries.map(e => e.details)).toEqual([
        { a: 1 },
        { b: 2 },
      ]);
    });

    it('rend null plutôt que d’échouer sur un détail illisible', async () => {
      // Une trace partiellement lisible vaut mieux qu'une page d'audit qui
      // refuse de s'afficher.
      const { service } = build(true, [
        ligne({ id: 1, details: 'pas du json' as never }),
        ligne({ id: 2, details: '[1,2]' as never }),
        ligne({ id: 3, details: null }),
      ]);

      expect((await service.list(requete())).entries.map(e => e.details)).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('normalise l’horodatage en ISO', async () => {
      const { service } = build(true, [ligne({ created_at: '2026-01-01 08:30:00' })]);
      expect((await service.list(requete())).entries[0]?.createdAt).toMatch(
        /^2026-01-01T\d{2}:30:00/,
      );
    });
  });
});
