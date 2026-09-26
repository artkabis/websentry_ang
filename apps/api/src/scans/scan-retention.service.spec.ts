import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ScanRetentionRepository } from '../database/repositories/scan-retention.repository.js';
import type { ScanTrashService } from './scan-trash.service.js';
import { ScanRetentionService } from './scan-retention.service.js';

function build(options: { available?: boolean; enabled?: boolean; batchSize?: number } = {}) {
  const { available = true, enabled = true, batchSize = 500 } = options;

  const repo = {
    available,
    findCompressible: vi.fn().mockResolvedValue([]),
    compress: vi.fn().mockImplementation((updates: unknown[]) => Promise.resolve(updates.length)),
    purge: vi.fn().mockResolvedValue(0),
    countPending: vi.fn().mockResolvedValue({ compressible: 0, purgeable: 0 }),
  };

  const config = {
    retention: {
      enabled,
      compressAfterDays: 7,
      purgeAfterDays: 180,
      trashRetentionDays: 30,
      batchSize,
    },
  };

  const corbeille = { purgerEchues: vi.fn().mockResolvedValue(0) };

  const service = new ScanRetentionService(
    repo as unknown as ScanRetentionRepository,
    config as unknown as AppConfigService,
    corbeille as unknown as ScanTrashService,
  );
  return { service, repo, config, corbeille };
}

describe('ScanRetentionService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('ne fait rien quand la base est absente', async () => {
    const off = build({ available: false });
    await expect(off.service.run()).resolves.toEqual({
      compressed: 0,
      purged: 0,
      trashPurged: 0,
      remaining: 0,
      durationMs: 0,
    });
    expect(off.repo.findCompressible).not.toHaveBeenCalled();
  });

  it('ne fait rien quand la rétention est désactivée', async () => {
    const off = build({ enabled: false });
    await off.service.run();
    expect(off.repo.findCompressible).not.toHaveBeenCalled();
  });

  it('applique les seuils de la configuration', async () => {
    await t.service.run();
    expect(t.repo.findCompressible).toHaveBeenCalledWith(7, 500);
    expect(t.repo.purge).toHaveBeenCalledWith(180, 500);
  });

  it('compresse les rapports trouvés', async () => {
    t.repo.findCompressible.mockResolvedValue([
      { id: 'p1', report: '{"a":1}' },
      { id: 'p2', report: '{"b":2}' },
    ]);
    const result = await t.service.run();
    expect(result.compressed).toBe(2);
  });

  it('produit un gzip relisible', async () => {
    t.repo.findCompressible.mockResolvedValue([{ id: 'p1', report: '{"a":1}' }]);
    await t.service.run();
    const [updates] = t.repo.compress.mock.calls[0] as [Array<{ gz: Buffer }>];
    expect(gunzipSync(updates[0]!.gz).toString('utf8')).toBe('{"a":1}');
  });

  it('n’écrit pas quand il n’y a rien à compresser', async () => {
    await t.service.run();
    expect(t.repo.compress).not.toHaveBeenCalled();
  });

  it('LAISSE en clair une ligne qui résiste, sans faire échouer le lot', async () => {
    // Un rapport corrompu ne doit pas empêcher les 499 autres d'être compressés.
    // La ligne est reprise au passage suivant.
    t.repo.findCompressible.mockResolvedValue([
      { id: 'p1', report: null as unknown as string },
      { id: 'p2', report: '{"b":2}' },
    ]);
    const result = await t.service.run();
    expect(result.compressed).toBe(1);
    const [updates] = t.repo.compress.mock.calls[0] as [Array<{ id: string }>];
    expect(updates.map(u => u.id)).toEqual(['p2']);
  });

  it('remonte le nombre de lignes purgées', async () => {
    t.repo.purge.mockResolvedValue(42);
    await expect(t.service.run()).resolves.toMatchObject({ purged: 42 });
  });

  it('SIGNALE le retard accumulé', async () => {
    // La v1 s'arrêtait à sa borne sans jamais dire qu'elle prenait du retard :
    // une file grandissant plus vite qu'elle ne se vide restait invisible
    // jusqu'au jour où le disque était plein.
    t.repo.countPending.mockResolvedValue({ compressible: 1200, purgeable: 300 });
    await expect(t.service.run()).resolves.toMatchObject({ remaining: 1500 });
  });

  it('mesure la durée du passage', async () => {
    const result = await t.service.run();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('REFUSE un second passage concurrent', async () => {
    // Deux passages simultanés compresseraient les mêmes lignes en double.
    let release: (() => void) | undefined;
    t.repo.findCompressible.mockImplementation(
      () => new Promise(resolve => (release = () => resolve([]))),
    );

    const first = t.service.run();
    const second = await t.service.run();
    expect(second).toMatchObject({ compressed: 0, purged: 0, trashPurged: 0, durationMs: 0 });

    release?.();
    await first;
  });

  it('libère le verrou même en cas d’échec', async () => {
    t.repo.findCompressible.mockRejectedValueOnce(new Error('base injoignable'));
    await expect(t.service.run()).rejects.toThrow('base injoignable');

    t.repo.findCompressible.mockResolvedValue([]);
    await expect(t.service.run()).resolves.toMatchObject({ compressed: 0 });
  });
});

describe('ScanRetentionService — trace du dernier passage', () => {
  it('n’annonce AUCUN passage avant le premier', () => {
    // « Aucun passage depuis le démarrage » se distingue de « rien à faire ».
    const t = build();
    expect(t.service.dernierPassage()).toBeNull();
  });

  it('retient un passage réussi, avec ses compteurs', async () => {
    const t = build();
    t.repo.findCompressible.mockResolvedValue([]);
    t.repo.purge.mockResolvedValue(7);
    t.repo.countPending.mockResolvedValue({ compressible: 2, purgeable: 1 });

    await t.service.run();

    expect(t.service.dernierPassage()).toMatchObject({
      purges: 7,
      restants: 3,
      reussi: true,
    });
  });

  it('RETIENT aussi l’échec, avant de le relancer', async () => {
    // Sans cela, la supervision afficherait le dernier passage réussi et
    // laisserait croire que tout va bien, alors que la file grandit depuis.
    const t = build();
    t.repo.findCompressible.mockRejectedValue(new Error('base injoignable'));

    await expect(t.service.run()).rejects.toThrow('base injoignable');
    expect(t.service.dernierPassage()).toMatchObject({ reussi: false });
  });

  it('REMPLACE la trace précédente à chaque passage', async () => {
    const t = build();
    t.repo.findCompressible.mockResolvedValue([]);
    t.repo.purge.mockResolvedValue(1);
    t.repo.countPending.mockResolvedValue({ compressible: 0, purgeable: 0 });
    await t.service.run();

    t.repo.purge.mockResolvedValue(9);
    await t.service.run();

    expect(t.service.dernierPassage()?.purges).toBe(9);
  });

  it('ne retient RIEN quand la rétention est désactivée', async () => {
    // Le passage ne s'exécute pas : annoncer une trace donnerait à croire
    // qu'un travail a eu lieu.
    const t = build({ enabled: false });
    await t.service.run();

    expect(t.service.dernierPassage()).toBeNull();
  });
});
