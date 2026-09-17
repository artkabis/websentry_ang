import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { PermissionRepository } from './permission.repository.js';

function build() {
  const db = {
    enabled: true,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
  };
  return { repo: new PermissionRepository(db as unknown as DatabaseService), db };
}

describe('PermissionRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('filtre les grants EXPIRÉS côté SQL, pour tous les appelants', async () => {
    // Le filtre est dans la requête et non dans le code appelant : aucun chemin
    // d'appel ne peut l'oublier.
    await t.repo.findAllForUser('u1');
    const [sql] = t.db.query.mock.calls[0] as [string];
    expect(sql).toContain('expires_at IS NULL OR expires_at > NOW()');
  });

  it('paramètre l’identifiant utilisateur', async () => {
    await t.repo.findAllForUser("u1' OR 1=1 --");
    const [, params] = t.db.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["u1' OR 1=1 --"]);
  });

  it('applique le même filtre d’expiration à la recherche unitaire', async () => {
    await t.repo.findOne('u1', 'users:read');
    const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('expires_at IS NULL OR expires_at > NOW()');
    expect(sql).toContain('AND permission = ?');
    expect(params).toEqual(['u1', 'users:read']);
  });

  it('borne la recherche unitaire à une ligne', async () => {
    await t.repo.findOne('u1', 'users:read');
    expect((t.db.queryOne.mock.calls[0] as [string])[0]).toContain('LIMIT 1');
  });
});
