import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { ScanRetentionRepository } from './scan-retention.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
  };
  return { repo: new ScanRetentionRepository(db as unknown as DatabaseService), db };
}

describe('ScanRetentionRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('findCompressible', () => {
    it('cible les rapports en clair passé le seuil', async () => {
      await t.repo.findCompressible(7, 500);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('is_compressed = 0');
      expect(sql).toContain('report IS NOT NULL');
      expect(params).toEqual([7, 500]);
    });

    it('compte les jours en UTC, pas dans le fuseau du serveur', async () => {
      await t.repo.findCompressible(7, 500);
      const [sql] = t.db.query.mock.calls[0] as [string];
      expect(sql).toContain('DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)');
    });

    it('traite les plus anciens d’abord', async () => {
      await t.repo.findCompressible(7, 500);
      const [sql] = t.db.query.mock.calls[0] as [string];
      expect(sql).toContain('ORDER BY analyzed_at ASC');
    });
  });

  describe('compress', () => {
    it('n’écrit rien pour un lot vide', async () => {
      await expect(t.repo.compress([])).resolves.toBe(0);
      expect(t.db.execute).not.toHaveBeenCalled();
    });

    it('groupe le lot en UN SEUL UPDATE', async () => {
      // Sur un lot de 200, la différence entre un aller-retour et deux cents
      // décide si le travail de fond tient dans sa fenêtre.
      const gz = Buffer.from('x');
      await t.repo.compress([
        { id: 'a', gz },
        { id: 'b', gz },
      ]);
      expect(t.db.execute).toHaveBeenCalledTimes(1);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('CASE WHEN id = ? THEN ? WHEN id = ? THEN ? END');
      expect(sql).toContain('WHERE id IN (?,?)');
      expect(params).toEqual(['a', gz, 'b', gz, 'a', 'b']);
    });

    it('vide la colonne en clair et lève l’indicateur', async () => {
      await t.repo.compress([{ id: 'a', gz: Buffer.from('x') }]);
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('report = NULL');
      expect(sql).toContain('is_compressed = 1');
    });
  });

  describe('purge', () => {
    it('DATE la purge — la distinction qui manquait à la v1', async () => {
      await t.repo.purge(180, 500);
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('report_purged_at = UTC_TIMESTAMP()');
    });

    it('BORNE le lot', async () => {
      // Sans LIMIT, un premier passage sur une base de production
      // verrouillerait des millions de lignes en une seule instruction.
      const [sql, params] = await t.repo
        .purge(180, 500)
        .then(() => t.db.execute.mock.calls[0] as [string, unknown[]]);
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual([180, 500]);
    });

    it('ne touche que les lignes portant encore un rapport', async () => {
      await t.repo.purge(180, 500);
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('(report IS NOT NULL OR report_gz IS NOT NULL)');
    });
  });

  describe('countPending', () => {
    it('compte les deux files en une requête', async () => {
      t.db.queryOne.mockResolvedValue({ compressible: '120', purgeable: '30' });
      await expect(t.repo.countPending(7, 180)).resolves.toMatchObject({
        compressible: 120,
        purgeable: 30,
      });
      const [, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([7, 180]);
    });

    it('rend zéro sur une table vide', async () => {
      await expect(t.repo.countPending(7, 180)).resolves.toMatchObject({
        compressible: 0,
        purgeable: 0,
      });
    });

    it('rend zéro quand les sommes SQL valent NULL', async () => {
      t.db.queryOne.mockResolvedValue({ compressible: null, purgeable: null });
      await expect(t.repo.countPending(7, 180)).resolves.toMatchObject({
        compressible: 0,
        purgeable: 0,
      });
    });
  });
});
