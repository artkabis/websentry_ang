import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { UserRepository } from './user.repository.js';

/**
 * Ces tests vérifient le CONTRAT SQL du repository : requête paramétrée, valeurs
 * passées à part, colonnes listées explicitement. Le comportement du driver
 * lui-même relève des tests d'intégration contre une vraie MariaDB.
 */
function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
  };
  return { repo: new UserRepository(db as unknown as DatabaseService), db };
}

describe('UserRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(true).repo.available).toBe(true);
    expect(build(false).repo.available).toBe(false);
  });

  describe('findByUsername', () => {
    it('passe l’identifiant en PARAMÈTRE, jamais concaténé au SQL', async () => {
      await t.repo.findByUsername("alice' OR '1'='1");

      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE username = ?');
      expect(sql).not.toContain("OR '1'='1");
      expect(params).toEqual(["alice' OR '1'='1"]);
    });

    it('n’expose pas password_hash par un SELECT * implicite', async () => {
      // Les colonnes sont listées : une colonne ajoutée plus tard au schéma
      // n'atterrit pas automatiquement dans le code d'authentification.
      await t.repo.findByUsername('alice');
      const [sql] = t.db.queryOne.mock.calls[0] as [string];
      expect(sql).not.toContain('SELECT *');
      expect(sql).toContain('password_hash'); // explicitement demandé, car nécessaire ici
    });

    it('borne le résultat à une ligne', async () => {
      await t.repo.findByUsername('alice');
      expect((t.db.queryOne.mock.calls[0] as [string])[0]).toContain('LIMIT 1');
    });
  });

  describe('findById', () => {
    it('paramètre l’identifiant', async () => {
      await t.repo.findById('u1');
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE id = ?');
      expect(params).toEqual(['u1']);
    });
  });

  describe('recordFailedLogin', () => {
    it('écrit le compteur et la date de verrouillage en paramètres', async () => {
      const until = new Date('2026-01-01T00:00:00Z');
      await t.repo.recordFailedLogin('u1', 3, until);

      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('UPDATE users SET failed_logins = ?, locked_until = ?');
      expect(params).toEqual([3, until, 'u1']);
    });

    it('accepte une absence de verrouillage', async () => {
      await t.repo.recordFailedLogin('u1', 1, null);
      expect((t.db.execute.mock.calls[0] as [string, unknown[]])[1]).toEqual([1, null, 'u1']);
    });
  });

  describe('resetFailedLogins', () => {
    it('remet le compteur à zéro et lève le verrou', async () => {
      await t.repo.resetFailedLogins('u1');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('failed_logins = 0');
      expect(sql).toContain('locked_until = NULL');
      expect(params).toEqual(['u1']);
    });
  });

  describe('bumpTokenVersion', () => {
    it('incrémente côté SQL — pas de lecture-modification-écriture en deux temps', async () => {
      // Un incrément applicatif perdrait des révocations concurrentes.
      await t.repo.bumpTokenVersion('u1');
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('token_version = token_version + 1');
    });
  });
});
