import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('répond ok avec la version applicative', () => {
    expect(new HealthController().check()).toEqual({ ok: true, version: '2.0.0' });
  });

  it('n’expose AUCUNE information d’infrastructure', () => {
    // Une sonde bavarde (état de la base, nom d'hôte, versions de dépendances)
    // est un outil de reconnaissance offert gratuitement.
    const body = new HealthController().check() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['ok', 'version']);
  });
});
