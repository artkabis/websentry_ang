import { ALL_CHECKS, SUB_CHECKS_REGISTRY } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import { RegistryController } from './registry.controller.js';

describe('RegistryController', () => {
  const controller = new RegistryController();

  it('sert le registre complet depuis le paquet partagé', () => {
    const registry = controller.get();
    expect(registry.checks).toBe(ALL_CHECKS);
    expect(registry.subChecks).toBe(SUB_CHECKS_REGISTRY);
  });

  it('n’expose QUE les critères visibles — les critères internes sont fusionnés ailleurs', () => {
    expect(controller.get().checks.every(c => !c.internal)).toBe(true);
  });

  it('expose la volumétrie par groupe', () => {
    const stats = controller.stats();
    expect(stats.subChecksTotal).toBe(SUB_CHECKS_REGISTRY.length);
    expect(Object.keys(stats.byGroup).sort()).toEqual(['Design', 'SEO', 'Technique']);
  });

  it('garde une volumétrie cohérente avec le registre', () => {
    const stats = controller.stats();
    expect(stats.visibleTotal).toBe(ALL_CHECKS.length);
    expect(stats.visibleTotal + stats.internalTotal).toBe(stats.registryTotal);
  });
});
