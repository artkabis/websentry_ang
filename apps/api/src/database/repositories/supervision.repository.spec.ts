import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { SupervisionRepository } from './supervision.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
  };
  return { repo: new SupervisionRepository(db as unknown as DatabaseService), db };
}

describe('SupervisionRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  it('rend 0 plutôt que null quand une requête ne ramène rien', async () => {
    // Un `null` remonterait jusqu'au schéma de sortie, qui le refuserait, et
    // ferait échouer tout le relevé pour un compteur vide.
    expect(await t.repo.scans24h()).toBe(0);
    expect(await t.repo.scans7j()).toBe(0);
    expect(await t.repo.comptesActifs()).toBe(0);
    expect(await t.repo.retoursOuverts()).toBe(0);
  });

  it('rend le total quand la ligne existe', async () => {
    t.db.queryOne.mockResolvedValue({ total: 412 });
    expect(await t.repo.scans24h()).toBe(412);
  });

  describe('bornes des comptages', () => {
    it('BORNE les scans dans le temps, pour ne pas grossir avec la table', async () => {
      // Un COUNT(*) sur toute la table des pages ferait de la supervision la
      // requête la plus coûteuse de l'application.
      await t.repo.scans24h();
      await t.repo.scans7j();

      const [sql24h] = t.db.queryOne.mock.calls[0] as [string];
      const [sql7j] = t.db.queryOne.mock.calls[1] as [string];
      expect(sql24h).toContain('INTERVAL 1 DAY');
      expect(sql7j).toContain('INTERVAL 7 DAY');
    });

    it('ne compte QUE les comptes actifs', async () => {
      await t.repo.comptesActifs();
      expect((t.db.queryOne.mock.calls[0] as [string])[0]).toContain("status = 'active'");
    });

    it('ne compte QUE les retours qui attendent une décision', async () => {
      // Inclure les résolus et les rejetés ferait un compteur qui ne
      // redescend jamais, donc qu'on cesse de regarder.
      await t.repo.retoursOuverts();
      const [sql] = t.db.queryOne.mock.calls[0] as [string];

      expect(sql).toContain("IN ('nouveau', 'accepte', 'en_cours')");
      expect(sql).not.toContain('resolu');
    });
  });

  describe('surface', () => {
    it('ne lit AUCUNE donnée nominative — que des comptages', async () => {
      // La supervision dit ce que l'instance PORTE, pas ce qu'elle contient :
      // une page qui listerait des domaines serait une page d'analyse.
      for (const compter of [
        () => t.repo.scans24h(),
        () => t.repo.scans7j(),
        () => t.repo.comptesActifs(),
        () => t.repo.retoursOuverts(),
      ]) {
        await compter();
      }

      for (const appel of t.db.queryOne.mock.calls as Array<[string]>) {
        expect(appel[0]).toMatch(/^SELECT COUNT\(\*\) AS total/);
        expect(appel[0]).not.toContain('SELECT *');
      }
    });

    it('n’expose AUCUNE écriture', () => {
      const methodes = Object.getOwnPropertyNames(SupervisionRepository.prototype).filter(
        n => n !== 'constructor' && n !== 'compter',
      );
      expect(methodes.sort()).toEqual([
        'available',
        'comptesActifs',
        'retoursOuverts',
        'scans24h',
        'scans7j',
      ]);
    });
  });
});
