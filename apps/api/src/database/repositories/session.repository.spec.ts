import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { SessionRepository } from './session.repository.js';

function build() {
  const conn = { execute: vi.fn().mockResolvedValue([{}]) };
  const db = {
    enabled: true,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
    transaction: vi.fn(async (fn: (c: typeof conn) => Promise<unknown>) => fn(conn)),
  };
  return { repo: new SessionRepository(db as unknown as DatabaseService), db, conn };
}

describe('SessionRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('generateRawToken', () => {
    it('produit 32 octets d’entropie en base64url', () => {
      const token = t.repo.generateRawToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    });

    it('ne produit jamais deux fois la même valeur', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => t.repo.generateRawToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('hashToken', () => {
    it('applique SHA-256', () => {
      expect(t.repo.hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    });
  });

  describe('create', () => {
    it('stocke l’EMPREINTE, jamais le jeton brut', async () => {
      // Une fuite de la table ne doit pas permettre de rejouer les sessions.
      const raw = await t.repo.create('u1', 3600_000, '1.2.3.4', 'Mozilla');

      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO user_sessions');
      expect(params).not.toContain(raw);
      expect(params).toContain(t.repo.hashToken(raw));
    });

    it('retourne le jeton brut à l’appelant — seule occasion où il existe', async () => {
      const raw = await t.repo.create('u1', 3600_000, null, null);
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('tronque un User-Agent surdimensionné à la largeur de colonne', async () => {
      await t.repo.create('u1', 3600_000, null, 'x'.repeat(2000));
      const params = (t.db.execute.mock.calls[0] as [string, unknown[]])[1];
      expect(String(params[5])).toHaveLength(512);
    });

    it('enregistre NULL plutôt qu’une chaîne vide pour le User-Agent', async () => {
      await t.repo.create('u1', 3600_000, null, '');
      expect((t.db.execute.mock.calls[0] as [string, unknown[]])[1][5]).toBeNull();
    });

    it('calcule la date d’expiration à partir de la durée fournie', async () => {
      const before = Date.now();
      await t.repo.create('u1', 3600_000, null, null);
      const expiresAt = (t.db.execute.mock.calls[0] as [string, unknown[]])[1][3] as Date;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    });
  });

  describe('findByRawToken', () => {
    it('recherche par empreinte, jointe à l’utilisateur', async () => {
      await t.repo.findByRawToken('jeton-brut');
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INNER JOIN users');
      expect(sql).toContain('WHERE s.token_hash = ?');
      expect(params).toEqual([t.repo.hashToken('jeton-brut')]);
    });
  });

  describe('rotate', () => {
    it('révoque et recrée dans une SEULE transaction', async () => {
      // Un échec entre les deux déconnecterait l'utilisateur sans recours.
      await t.repo.rotate('s1', 'u1', 3600_000, '1.2.3.4', 'Mozilla');

      expect(t.db.transaction).toHaveBeenCalledOnce();
      const statements = t.conn.execute.mock.calls.map(c => (c as [string])[0]);
      expect(statements[0]).toContain('UPDATE user_sessions SET revoked = 1');
      expect(statements[1]).toContain('INSERT INTO user_sessions');
    });

    it('retourne un jeton DIFFÉRENT de l’ancien', async () => {
      const fresh = await t.repo.rotate('s1', 'u1', 3600_000, null, null);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(fresh).not.toBe('s1');
    });

    it('ne stocke que l’empreinte du nouveau jeton', async () => {
      const fresh = await t.repo.rotate('s1', 'u1', 3600_000, null, null);
      const insertParams = (t.conn.execute.mock.calls[1] as [string, unknown[]])[1];
      expect(insertParams).toContain(t.repo.hashToken(fresh));
      expect(insertParams).not.toContain(fresh);
    });
  });

  describe('revokeAllForUser', () => {
    it('ne touche que les sessions encore actives', async () => {
      await t.repo.revokeAllForUser('u1');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE user_id = ? AND revoked = 0');
      expect(params).toEqual(['u1']);
    });
  });

  describe('deleteExpired', () => {
    it('supprime les sessions dont la date d’expiration est passée', async () => {
      await t.repo.deleteExpired();
      expect((t.db.execute.mock.calls[0] as [string])[0]).toContain('expires_at < NOW()');
    });
  });
});
