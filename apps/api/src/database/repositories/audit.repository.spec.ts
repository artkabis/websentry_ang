import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { AuditRepository } from './audit.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
  };
  return { repo: new AuditRepository(db as unknown as DatabaseService), db };
}

describe('AuditRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  it('n’expose AUCUNE méthode d’UPDATE ou de DELETE — append-only par construction', () => {
    // L'interdiction est structurelle : aucun code applicatif ne peut réécrire
    // l'historique, même par erreur.
    const methods = Object.getOwnPropertyNames(AuditRepository.prototype);
    expect(methods.filter(m => /update|delete|remove|purge|truncate/i.test(m))).toEqual([]);
    expect(methods).toContain('append');
    expect(methods).toContain('list');
  });

  describe('append', () => {
    it('insère l’entrée en paramètres', async () => {
      await t.repo.append({
        actorId: 'u1',
        actorName: 'alice',
        action: 'auth.login',
        targetId: 'u2',
        targetType: 'user',
        details: { role: 'admin' },
        ipAddress: '1.2.3.4',
      });

      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO audit_log');
      expect(params).toEqual([
        'u1',
        'alice',
        'auth.login',
        'u2',
        'user',
        JSON.stringify({ role: 'admin' }),
        '1.2.3.4',
      ]);
    });

    it('sérialise les détails en JSON', async () => {
      await t.repo.append({
        actorId: null,
        actorName: null,
        action: 'x',
        details: { a: 1, b: ['c'] },
      });
      const params = (t.db.execute.mock.calls[0] as [string, unknown[]])[1];
      expect(params[5]).toBe('{"a":1,"b":["c"]}');
    });

    it('enregistre NULL pour les champs facultatifs omis', async () => {
      await t.repo.append({ actorId: null, actorName: null, action: 'x' });
      const params = (t.db.execute.mock.calls[0] as [string, unknown[]])[1];
      expect(params.slice(3)).toEqual([null, null, null, null]);
    });
  });

  describe('list', () => {
    it('trie du plus récent au plus ancien et pagine', async () => {
      await t.repo.list(25, 50);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(sql).toContain('LIMIT ? OFFSET ?');
      expect(params).toEqual([25, 50]);
    });
  });
});
