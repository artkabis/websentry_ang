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

describe('AuditRepository — lecture filtrée', () => {
  /** Clause WHERE isolée, espaces normalisés. */
  function whereDe(sql: string): string {
    return (/WHERE .*?(?= ORDER BY|$)/s.exec(sql)?.[0] ?? '').replace(/\s+/g, ' ').trim();
  }

  it('n’ajoute aucune clause WHERE sans filtre', async () => {
    const t = build();
    await t.repo.list(50, 0);
    const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([50, 0]);
  });

  it('lit la plus récente d’abord, départage par identifiant', async () => {
    // Deux traces à la même seconde doivent garder un ordre stable, sans quoi
    // la pagination peut en sauter ou en répéter.
    const t = build();
    await t.repo.list(50, 0);
    expect((t.db.query.mock.calls[0] as [string])[0]).toContain(
      'ORDER BY created_at DESC, id DESC',
    );
  });

  it('PARAMÈTRE la recherche d’acteur, joker compris', async () => {
    const t = build();
    await t.repo.list(50, 0, { actor: "alice' OR 1=1 --" });
    const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('(actor_name LIKE ? OR actor_id = ?)');
    expect(sql).not.toContain('%');
    expect(params.slice(0, 2)).toEqual(["%alice' OR 1=1 --%", "alice' OR 1=1 --"]);
  });

  it('filtre l’action par PRÉFIXE, pour ramener une famille entière', async () => {
    const t = build();
    await t.repo.list(50, 0, { action: 'user.' });
    const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('action LIKE ?');
    expect(params[0]).toBe('user.%');
  });

  it('rend la borne de fin INCLUSIVE', async () => {
    // « jusqu'au 31 » doit contenir le 31 tout entier, et non s'arrêter à son
    // premier instant.
    const t = build();
    await t.repo.list(50, 0, { from: '2026-01-01', to: '2026-01-31' });
    const [, params] = t.db.query.mock.calls[0] as [string, unknown[]];

    expect(params[0]).toBe('2026-01-01 00:00:00');
    expect(params[1]).toBe('2026-01-31 23:59:59');
  });

  it('applique au COMPTAGE exactement le même filtre qu’à la lecture', async () => {
    const t = build();
    const filtres = { actor: 'alice', action: 'user.', targetId: 'u-2', from: '2026-01-01' };
    await t.repo.list(50, 0, filtres);
    await t.repo.count(filtres);

    const [sqlListe, paramsListe] = t.db.query.mock.calls[0] as [string, unknown[]];
    const [sqlTotal, paramsTotal] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

    expect(whereDe(sqlTotal)).toBe(whereDe(sqlListe));
    expect(paramsListe).toEqual([...paramsTotal, 50, 0]);
  });

  it('rend 0 quand le comptage ne ramène rien', async () => {
    expect(await build().repo.count()).toBe(0);
  });

  it('rend le total quand la ligne existe', async () => {
    const t = build();
    t.db.queryOne.mockResolvedValue({ total: 412 });
    expect(await t.repo.count({ actor: 'alice' })).toBe(412);
  });

  it('ne lit PAS avec une étoile — les colonnes sont explicites', async () => {
    // Une colonne ajoutée plus tard au schéma ne doit pas se retrouver
    // automatiquement exposée par la route de lecture.
    const t = build();
    await t.repo.list(50, 0);
    expect((t.db.query.mock.calls[0] as [string])[0]).not.toContain('SELECT *');
  });
});
