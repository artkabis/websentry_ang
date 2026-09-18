import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ScanRetentionService } from './scan-retention.service.js';
import { ScansModule } from './scans.module.js';

function build(enabled = true) {
  const retention = { run: vi.fn().mockResolvedValue({}) };
  const config = {
    retention: { enabled, compressAfterDays: 7, purgeAfterDays: 180, batchSize: 500 },
  };
  const module = new ScansModule(
    retention as unknown as ScanRetentionService,
    config as unknown as AppConfigService,
  );
  return { module, retention };
}

describe('ScansModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lance un premier passage au démarrage', async () => {
    // Il rattrape ce qu'un arrêt prolongé a laissé s'accumuler.
    const t = build();
    t.module.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.retention.run).toHaveBeenCalledTimes(1);
    t.module.onModuleDestroy();
  });

  it('répète le passage chaque jour', async () => {
    const t = build();
    t.module.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(t.retention.run).toHaveBeenCalledTimes(2);
    t.module.onModuleDestroy();
  });

  it('DÉTACHE le minuteur de la boucle d’événements', () => {
    // Sans `unref()`, le processus refuserait de s'arrêter pendant les heures
    // séparant deux passages — un conteneur qui ne répond plus à SIGTERM finit
    // tué de force.
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
      unref,
    } as unknown as NodeJS.Timeout);
    try {
      const t = build();
      t.module.onApplicationBootstrap();
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('ne programme rien quand la rétention est désactivée', () => {
    const t = build(false);
    t.module.onApplicationBootstrap();
    expect(t.retention.run).not.toHaveBeenCalled();
  });

  it('arrête le minuteur à la destruction du module', async () => {
    const t = build();
    t.module.onApplicationBootstrap();
    t.module.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(t.retention.run).toHaveBeenCalledTimes(1);
  });

  it('tolère une destruction sans démarrage', () => {
    expect(() => build().module.onModuleDestroy()).not.toThrow();
  });

  it('N’ABAT PAS l’API sur un échec de rétention', async () => {
    // Le service rendu ne dépend pas de la compression des rapports d'il y a
    // six mois.
    const t = build();
    t.retention.run.mockRejectedValue(new Error('base injoignable'));

    expect(() => t.module.onApplicationBootstrap()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    // L'échec est absorbé, et le passage suivant reste programmé.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(t.retention.run).toHaveBeenCalledTimes(2);
    t.module.onModuleDestroy();
  });
});
