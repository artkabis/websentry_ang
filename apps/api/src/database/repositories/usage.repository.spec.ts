import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { UsageRepository } from './usage.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
  };
  return { repo: new UsageRepository(db as unknown as DatabaseService), db };
}

const DEPUIS = '2026-01-01 00:00:00';

/** Tout le SQL émis par un appel, espaces normalisés. */
function sqlDe(appels: { mock: { calls: unknown[][] } }): string {
  return appels.mock.calls
    .map(appel => String(appel[0]))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('UsageRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('ce que les lectures NE ramènent PAS', () => {
    it('ne SÉLECTIONNE jamais une identité', async () => {
      // C'est la garantie du module, et le seul endroit où elle peut être
      // posée : une fois la donnée remontée, la retirer relèverait de la
      // discipline.
      await t.repo.comptesActifs(DEPUIS);
      await t.repo.compteurAudit(['auth.login'], DEPUIS);
      await t.repo.compteurAnalyses(DEPUIS);
      await t.repo.connexionsParJour(DEPUIS);
      await t.repo.analysesParJour(DEPUIS);
      await t.repo.gammes(DEPUIS);

      const sql = `${sqlDe(t.db.query)} ${sqlDe(t.db.queryOne)}`;
      // `actor_id` et `launched_by` n'apparaissent que sous un COUNT DISTINCT
      // ou dans un WHERE, jamais comme colonne rendue.
      expect(sql).not.toMatch(/SELECT[^;]*\bactor_name\b/);
      expect(sql).not.toMatch(/SELECT[^;]*\bip_address\b/);
      expect(sql).not.toMatch(/SELECT\s+actor_id/);
      expect(sql).not.toMatch(/SELECT\s+launched_by/);
    });

    it('compte des COMPTES DISTINCTS, pas des événements', async () => {
      // Une personne qui se connecte quarante fois ne fait pas quarante
      // comptes : le tunnel parle de personnes qui atteignent une étape.
      await t.repo.compteurAudit(['auth.login'], DEPUIS);
      await t.repo.compteurAnalyses(DEPUIS);

      expect(sqlDe(t.db.queryOne)).toContain('COUNT(DISTINCT actor_id)');
      expect(sqlDe(t.db.queryOne)).toContain('COUNT(DISTINCT launched_by)');
    });

    it('EXCLUT les lignes déjà anonymisées du décompte des comptes', async () => {
      // Une ligne sans acteur ne désigne plus personne : la compter comme un
      // compte actif inventerait un utilisateur.
      await t.repo.comptesActifs(DEPUIS);
      expect(sqlDe(t.db.queryOne)).toContain('actor_id IS NOT NULL');
    });
  });

  describe('paramétrage', () => {
    it('pose autant de « ? » que d’actions', async () => {
      await t.repo.compteurAudit(['a', 'b', 'c'], DEPUIS);
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('action IN (?, ?, ?)');
      expect(params).toEqual(['a', 'b', 'c', DEPUIS]);
    });

    it('n’interroge PAS la base pour une liste d’actions vide', async () => {
      await expect(t.repo.compteurAudit([], DEPUIS)).resolves.toBeNull();
      expect(t.db.queryOne).not.toHaveBeenCalled();
    });

    it('PARAMÈTRE la borne de temps partout', async () => {
      await t.repo.connexionsParJour("2026-01-01' OR 1=1 --");
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).not.toContain('OR 1=1');
      expect(params).toEqual(["2026-01-01' OR 1=1 --"]);
    });

    it('BORNE le nombre de gammes rendues', async () => {
      await t.repo.gammes(DEPUIS);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('LIMIT ?');
      expect(params[1]).toBe(20);
    });
  });

  describe('moyenne par gamme', () => {
    it('PONDÈRE par le nombre de pages', async () => {
      // Une session d'une page à 100 et une de cent pages à 50 ne pèsent pas
      // pareil : une moyenne de moyennes dirait 75 là où le site vaut 50,5.
      await t.repo.gammes(DEPUIS);
      const sql = sqlDe(t.db.query);

      expect(sql).toContain('avg_score * page_count');
      expect(sql).not.toContain('AVG(avg_score)');
    });

    it('rend NULL plutôt que zéro quand aucune page n’est notée', async () => {
      await t.repo.gammes(DEPUIS);
      expect(sqlDe(t.db.query)).toContain('THEN NULL');
    });
  });

  describe('gouvernance', () => {
    it('compte les lignes DÉJÀ anonymisées', async () => {
      await t.repo.lignesAnonymisees();
      expect(sqlDe(t.db.queryOne)).toContain('actor_id IS NULL AND actor_name IS NULL');
    });

    it('compte comme EN ATTENTE toute ligne qui garde une identité', async () => {
      // Un nom sans identifiant reste une identité : n'en vérifier qu'une
      // laisserait passer des lignes nominatives.
      await t.repo.lignesEnAttente('2025-07-01 00:00:00');
      const sql = sqlDe(t.db.queryOne);

      expect(sql).toContain('actor_id IS NOT NULL');
      expect(sql).toContain('actor_name IS NOT NULL');
      expect(sql).toContain('ip_address IS NOT NULL');
    });

    it('rend zéro quand le comptage ne ramène rien', async () => {
      await expect(t.repo.lignesAnonymisees()).resolves.toBe(0);
      await expect(t.repo.lignesEnAttente('2025-07-01 00:00:00')).resolves.toBe(0);
    });
  });

  describe('anonymisation', () => {
    it('ne retire QUE les trois colonnes identifiantes', async () => {
      // L'action, sa cible et son horodatage restent : ce sont eux qui font du
      // journal une preuve, et les effacer prétendrait que rien ne s'est passé.
      await t.repo.anonymiser('2025-07-01 00:00:00', 1000);
      const [sql] = t.db.execute.mock.calls[0] as [string];

      expect(sql).toContain('actor_id = NULL');
      expect(sql).toContain('actor_name = NULL');
      expect(sql).toContain('ip_address = NULL');
      expect(sql).not.toContain('action =');
      expect(sql).not.toContain('created_at =');
      expect(sql).not.toContain('target_id =');
      expect(sql).not.toContain('DELETE');
    });

    it('ne touche PAS une ligne déjà anonymisée', async () => {
      // Sans cette clause, chaque passage réécrirait tout le journal et
      // annoncerait un travail qu'il n'a pas fait.
      await t.repo.anonymiser('2025-07-01 00:00:00', 1000);
      const [sql] = t.db.execute.mock.calls[0] as [string];

      expect(sql).toContain('actor_id IS NOT NULL OR actor_name IS NOT NULL');
    });

    it('BORNE le lot, et commence par le plus ancien', async () => {
      await t.repo.anonymiser('2025-07-01 00:00:00', 500);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('ORDER BY created_at ASC');
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual(['2025-07-01 00:00:00', 500]);
    });

    it('rend le nombre de lignes touchées', async () => {
      t.db.execute.mockResolvedValueOnce(42);
      await expect(t.repo.anonymiser('2025-07-01 00:00:00', 1000)).resolves.toBe(42);
    });
  });
});
