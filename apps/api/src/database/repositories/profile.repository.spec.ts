import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { ProfileRepository } from './profile.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
  };
  return { repo: new ProfileRepository(db as unknown as DatabaseService), db };
}

describe('ProfileRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('list', () => {
    it('place le profil de repli en tête, puis trie alphabétiquement', async () => {
      // « default » est le repli universel : le présenter en premier dans
      // l'éditeur évite de le chercher au milieu des gammes commerciales.
      await t.repo.list();
      const [sql] = t.db.query.mock.calls[0] as [string];
      expect(sql).toContain("ORDER BY (gamme = 'default') DESC, gamme ASC");
    });

    it('ne rapatrie PAS la colonne settings — une liste doit rester légère', async () => {
      await t.repo.list();
      const [sql] = t.db.query.mock.calls[0] as [string];
      // On isole la clause SELECT : « settings » apparaît aussi dans le nom de
      // la table, et une recherche sur le SQL entier ne prouverait rien.
      const selectClause = sql.slice(0, sql.indexOf('FROM'));
      expect(selectClause).not.toContain('settings');
      expect(selectClause).toContain('version');
    });
  });

  describe('findByGamme', () => {
    it('paramètre la gamme et borne à une ligne', async () => {
      await t.repo.findByGamme("premium' OR '1'='1");
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE gamme = ?');
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(["premium' OR '1'='1"]);
    });

    it('charge les réglages, contrairement à la liste', async () => {
      await t.repo.findByGamme('premium');
      expect((t.db.queryOne.mock.calls[0] as [string])[0]).toContain('settings');
    });
  });

  describe('create', () => {
    it('insère en une seule opération, sans contrôle d’existence préalable', async () => {
      // `INSERT IGNORE` supprime la fenêtre de course entre un SELECT et un
      // INSERT : deux créations concurrentes ne peuvent pas toutes deux réussir.
      await t.repo.create('premium', 'Premium', null, { meta: 1 }, 'alice');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT IGNORE INTO settings_profiles');
      expect(params[0]).toBe('premium');
      expect(params[3]).toBe(JSON.stringify({ meta: 1 }));
    });

    it('démarre à la version 1', async () => {
      await t.repo.create('premium', 'Premium', null, {}, null);
      expect((t.db.execute.mock.calls[0] as [string])[0]).toContain('1,');
    });

    it('rend false quand la gamme existe déjà', async () => {
      t.db.execute.mockResolvedValue(0);
      await expect(t.repo.create('premium', 'Premium', null, {}, null)).resolves.toBe(false);
    });

    it('rend true quand la ligne est créée', async () => {
      t.db.execute.mockResolvedValue(1);
      await expect(t.repo.create('premium', 'Premium', null, {}, null)).resolves.toBe(true);
    });
  });

  describe('updateWithVersion', () => {
    it('incrémente la version DANS la même instruction que la condition', async () => {
      // C'est là que se joue l'atomicité : comparer puis écrire en deux temps
      // laisserait une fenêtre où une écriture concurrente passerait inaperçue.
      await t.repo.updateWithVersion('premium', 'Premium', null, {}, 'alice', 3);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('version = version + 1');
      expect(sql).toContain('AND version = ?');
      expect(params[params.length - 1]).toBe(3);
    });

    it('omet la condition de version quand aucune n’est attendue', async () => {
      await t.repo.updateWithVersion('premium', 'Premium', null, {}, 'alice', null);
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).not.toContain('AND version = ?');
      expect(sql).toContain('version = version + 1');
    });

    it('accepte la version 0 comme une condition, pas comme une absence', async () => {
      // Un test de vérité naïf sur `expectedVersion` traiterait 0 comme absent
      // et écraserait sans condition.
      await t.repo.updateWithVersion('premium', 'Premium', null, {}, null, 0);
      expect((t.db.execute.mock.calls[0] as [string])[0]).toContain('AND version = ?');
    });

    it('rend false quand aucune ligne n’est touchée — c’est le conflit', async () => {
      t.db.execute.mockResolvedValue(0);
      await expect(t.repo.updateWithVersion('premium', 'Premium', null, {}, null, 2)).resolves.toBe(
        false,
      );
    });

    it('sérialise les réglages en JSON', async () => {
      await t.repo.updateWithVersion('premium', 'Premium', null, { a: [1, 2] }, null, null);
      const params = (t.db.execute.mock.calls[0] as [string, unknown[]])[1];
      expect(params[2]).toBe('{"a":[1,2]}');
    });
  });

  describe('delete', () => {
    it('refuse le profil de repli AU NIVEAU SQL', async () => {
      // La protection est aussi appliquée par le service ; la répéter ici
      // garantit qu'aucun chemin d'appel ne peut la contourner.
      await t.repo.delete('default');
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain("AND gamme <> 'default'");
    });

    it('paramètre la gamme', async () => {
      await t.repo.delete('premium');
      expect((t.db.execute.mock.calls[0] as [string, unknown[]])[1]).toEqual(['premium']);
    });

    it('rend false quand rien n’a été supprimé', async () => {
      t.db.execute.mockResolvedValue(0);
      await expect(t.repo.delete('inconnue')).resolves.toBe(false);
    });
  });

  describe('currentVersion', () => {
    it('rend la version courante', async () => {
      t.db.queryOne.mockResolvedValue({ version: 7 });
      await expect(t.repo.currentVersion('premium')).resolves.toBe(7);
    });

    it('rend null quand la gamme n’existe pas', async () => {
      t.db.queryOne.mockResolvedValue(null);
      await expect(t.repo.currentVersion('inconnue')).resolves.toBeNull();
    });

    it('distingue la version 0 d’une absence', async () => {
      t.db.queryOne.mockResolvedValue({ version: 0 });
      await expect(t.repo.currentVersion('premium')).resolves.toBe(0);
    });
  });
});
