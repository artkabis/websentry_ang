import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanSearchQuerySchema } from '@websentry/shared';
import type { DatabaseService } from '../database.service.js';
import { ScanRepository, placeholders } from './scan.repository.js';

function build(enabled = true) {
  const transaction = vi.fn();
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
    transaction,
  };
  return { repo: new ScanRepository(db as unknown as DatabaseService), db };
}

function query(overrides: Record<string, unknown> = {}) {
  return ScanSearchQuerySchema.parse(overrides);
}

/** Dernier appel `query`, décomposé en SQL et paramètres. */
function lastQuery(db: ReturnType<typeof build>['db']): [string, unknown[]] {
  const calls = db.query.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

function lastQueryOne(db: ReturnType<typeof build>['db']): [string, unknown[]] {
  const calls = db.queryOne.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

describe('placeholders', () => {
  it('dérive les marqueurs de la LONGUEUR, jamais du contenu', () => {
    expect(placeholders(3)).toBe('?,?,?');
    expect(placeholders(0)).toBe('');
  });
});

describe('ScanRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('filtres de recherche', () => {
    it('n’émet aucune clause WHERE sans filtre', async () => {
      await t.repo.countPages(query());
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([]);
    });

    it('PARAMÈTRE toute valeur venue de l’appelant', async () => {
      await t.repo.countPages(
        query({ domain: "exemple' OR '1'='1", gamme: 'premium', epj: 'ABC' }),
      );
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).not.toContain("OR '1'='1");
      expect(params).toContain("%exemple' OR '1'='1%");
    });

    it('utilise l’index plein texte pour un terme indexable', async () => {
      await t.repo.countPages(query({ q: 'exemple' }));
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('MATCH(si.domain, si.epj) AGAINST (? IN BOOLEAN MODE)');
      expect(params).toEqual(['exemple*']);
    });

    it('RETOMBE sur LIKE pour un terme trop court pour l’index', async () => {
      // Le refuser laisserait croire qu'aucun site ne correspond.
      await t.repo.countPages(query({ q: 'fr' }));
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('si.domain LIKE ? OR si.epj LIKE ?');
      expect(params).toEqual(['%fr%', '%fr%']);
    });

    it('applique le score à la colonne de la PAGE dans la vue pages', async () => {
      await t.repo.countPages(query({ scoreMin: 3, scoreMax: 4 }));
      const [sql] = lastQueryOne(t.db);
      expect(sql).toContain('p.global_score >= ?');
      expect(sql).toContain('p.global_score <= ?');
    });

    it('applique le score à la MOYENNE de session dans la vue sites', async () => {
      // Appliquer le filtre à la mauvaise colonne donnerait des résultats
      // plausibles mais faux — pire qu'une erreur visible.
      await t.repo.countSites(query({ scoreMin: 3 }));
      const [sql] = lastQueryOne(t.db);
      expect(sql).toContain('ss.avg_score >= ?');
    });

    it('étend une date seule au jour entier', async () => {
      await t.repo.countPages(query({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }));
      const [, params] = lastQueryOne(t.db);
      expect(params).toEqual(['2026-06-01 00:00:00', '2026-06-30 23:59:59']);
    });

    it('CONVERTIT un instant ISO au lieu de le concaténer', async () => {
      // Le défaut de la v1 : la chaîne produite était coercée en silence par
      // MariaDB, et le filtre renvoyait alors tout l'historique.
      await t.repo.countPages(query({ dateFrom: '2026-06-04T12:00:00+02:00' }));
      const [, params] = lastQueryOne(t.db);
      expect(params).toEqual(['2026-06-04 10:00:00']);
    });

    it('filtre par session dans la vue pages', async () => {
      const sessionId = '11111111-1111-4111-8111-111111111111';
      await t.repo.countPages(query({ sessionId }));
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('p.session_id = ?');
      expect(params).toEqual([sessionId]);
    });

    it('IGNORE le filtre de session dans la vue sites — il n’y a pas de colonne', async () => {
      await t.repo.countSites(query({ sessionId: '11111111-1111-4111-8111-111111111111' }));
      const [, params] = lastQueryOne(t.db);
      expect(params).toEqual([]);
    });
  });

  describe('searchPages', () => {
    it('ne rapatrie PAS le rapport complet dans une liste', async () => {
      // Cent pages avec leurs rapports pèseraient plusieurs mégaoctets pour
      // n'en afficher aucun.
      await t.repo.searchPages(query(), 20, 0);
      const [sql] = lastQuery(t.db);
      const select = sql.slice(0, sql.indexOf('FROM'));
      expect(select).not.toContain('p.report,');
      expect(select).toContain('has_report');
    });

    it('place la pagination en dernier paramètre', async () => {
      await t.repo.searchPages(query({ gamme: 'premium' }), 20, 40);
      const [, params] = lastQuery(t.db);
      expect(params).toEqual(['premium', 20, 40]);
    });

    it('honore le tri demandé', async () => {
      await t.repo.searchPages(query({ sort: 'score', order: 'asc' }), 20, 0);
      const [sql] = lastQuery(t.db);
      expect(sql).toContain('ORDER BY p.global_score ASC, p.id ASC');
    });
  });

  describe('listSites', () => {
    it('conserve les sites SANS session, par une jointure externe', async () => {
      // Un site dont toutes les sessions ont été supprimées deviendrait sinon
      // invisible ET indestructible depuis l'interface.
      await t.repo.listSites(query(), 20, 0);
      const [sql] = lastQuery(t.db);
      expect(sql).toContain('LEFT JOIN');
      expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY s.site_id');
    });

    it('retombe sur la date de dernière vue quand le site n’a pas de session', async () => {
      await t.repo.listSites(query(), 20, 0);
      const [sql] = lastQuery(t.db);
      expect(sql).toContain('COALESCE(ss.analyzed_at, si.last_seen) AS last_scan');
    });
  });

  describe('listSiteSessions', () => {
    it('cible le site par sa clé d’identité', async () => {
      await t.repo.listSiteSessions('exemple.fr', null);
      const [sql, params] = lastQuery(t.db);
      expect(sql).toContain('WHERE si.identity_key = ?');
      expect(params).toEqual(['exemple.fr|']);
    });

    it('n’interroge PAS INFORMATION_SCHEMA à chaque appel', async () => {
      // La v1 vérifiait l'existence d'une colonne avant chaque lecture, pour
      // contourner une migration depuis appliquée : une requête de métadonnées
      // par requête servie.
      await t.repo.listSiteSessions('exemple.fr', 'premium');
      const [sql] = lastQuery(t.db);
      expect(sql).not.toContain('INFORMATION_SCHEMA');
    });
  });

  describe('lecture unitaire', () => {
    it('charge le rapport complet pour UNE page, contrairement à la liste', async () => {
      await t.repo.findPageWithReport('p1');
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('p.report, p.report_gz');
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(['p1']);
    });

    it('joint le domaine du site à la session', async () => {
      await t.repo.findSession('s1');
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('JOIN sites si ON si.id = ss.site_id');
      expect(sql).toContain('ss.profile_snapshot');
      expect(params).toEqual(['s1']);
    });

    it('ordonne les pages d’une session dans l’ordre d’analyse', async () => {
      await t.repo.listSessionPages('s1', 201);
      const [sql, params] = lastQuery(t.db);
      expect(sql).toContain('ORDER BY p.analyzed_at ASC, p.id ASC');
      expect(params).toEqual(['s1', 201]);
    });

    it('dédoublonne les sessions des pages visées', async () => {
      t.db.query.mockResolvedValue([{ session_id: 's1' }, { session_id: 's2' }]);
      await expect(t.repo.findSessionIdsForPages(['a', 'b'])).resolves.toEqual(['s1', 's2']);
      const [sql] = lastQuery(t.db);
      expect(sql).toContain('SELECT DISTINCT session_id');
    });

    it('compte les pages d’une session', async () => {
      t.db.queryOne.mockResolvedValue({ total: '7' });
      await expect(t.repo.countPagesForSession('s1')).resolves.toBe(7);
    });

    it('rend zéro quand la requête de décompte ne ramène rien', async () => {
      await expect(t.repo.countPagesForSession('s1')).resolves.toBe(0);
    });

    it('efface toutes les gammes d’un domaine', async () => {
      await t.repo.deleteDomain('exemple.fr');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toBe('DELETE FROM sites WHERE domain = ?');
      expect(params).toEqual(['exemple.fr']);
    });
  });

  describe('statistiques', () => {
    it('distingue les trois étages de stockage en une passe', async () => {
      await t.repo.statsSummary();
      const [sql] = lastQueryOne(t.db);
      expect(sql).toContain('SUM(report IS NOT NULL)');
      expect(sql).toContain('SUM(is_compressed = 1 AND report_gz IS NOT NULL)');
      expect(sql).toContain('SUM(report IS NULL AND report_gz IS NULL)');
    });

    it('borne la répartition par gamme', async () => {
      await t.repo.statsByGamme();
      const [sql] = lastQuery(t.db);
      expect(sql).toContain('WHERE si.gamme IS NOT NULL');
      expect(sql).toContain('LIMIT 50');
    });

    it('applique les seuils de l’échelle 0–5', async () => {
      await t.repo.statsScoreBuckets();
      const [sql] = lastQueryOne(t.db);
      expect(sql).toContain('SUM(global_score >= 4)');
      expect(sql).toContain('SUM(global_score >= 3 AND global_score < 4)');
    });

    it('paramètre la taille du palmarès de domaines', async () => {
      await t.repo.statsTopDomains(10);
      const [sql, params] = lastQuery(t.db);
      expect(sql).toContain('ORDER BY count DESC');
      expect(params).toEqual([10]);
    });
  });

  describe('listComparablePages', () => {
    it('ne charge que l’URL, le score et le résumé', async () => {
      await t.repo.listComparablePages('s1', 2000);
      const [sql] = lastQuery(t.db);
      expect(sql).not.toContain('report');
      expect(sql).toContain('p.check_summary');
    });

    it('borne le nombre de lignes', async () => {
      await t.repo.listComparablePages('s1', 2000);
      const [sql, params] = lastQuery(t.db);
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual(['s1', 2000]);
    });
  });

  describe('suppression', () => {
    it('ne construit aucune requête pour une liste vide', async () => {
      await expect(t.repo.deletePages([])).resolves.toBe(0);
      await expect(t.repo.findSessionIdsForPages([])).resolves.toEqual([]);
      expect(t.db.execute).not.toHaveBeenCalled();
    });

    it('lie chaque identifiant de la liste', async () => {
      await t.repo.deletePages(['a', 'b', 'c']);
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE id IN (?,?,?)');
      expect(params).toEqual(['a', 'b', 'c']);
    });

    it('compte les pages d’un site par la MÊME jointure que la suppression', async () => {
      // La v1 comptait par `scan_pages.domain` et supprimait par `sites.domain` :
      // le nombre annoncé ne correspondait pas à ce qui était effacé.
      await t.repo.countPagesForSite('exemple.fr', 'premium');
      const [countSql, countParams] = lastQueryOne(t.db);
      await t.repo.deleteSite('exemple.fr', 'premium');
      const [deleteSql, deleteParams] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(countSql).toContain('si.identity_key = ?');
      expect(deleteSql).toContain('identity_key = ?');
      expect(countParams).toEqual(deleteParams);
    });

    it('compte les pages d’un domaine par la jointure, toutes gammes confondues', async () => {
      await t.repo.countPagesForDomain('exemple.fr');
      const [sql, params] = lastQueryOne(t.db);
      expect(sql).toContain('WHERE si.domain = ?');
      expect(params).toEqual(['exemple.fr']);
    });

    it('supprime une session par son identifiant', async () => {
      await t.repo.deleteSession('s1');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toBe('DELETE FROM scan_sessions WHERE id = ?');
      expect(params).toEqual(['s1']);
    });
  });

  describe('reconcileSessions', () => {
    it('ne fait rien pour une liste vide', async () => {
      await t.repo.reconcileSessions([]);
      expect(t.db.execute).not.toHaveBeenCalled();
    });

    it('dédoublonne les identifiants', async () => {
      await t.repo.reconcileSessions(['s1', 's1', 's2']);
      const [, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['s1', 's2']);
    });

    it('écarte les valeurs vides', async () => {
      await t.repo.reconcileSessions(['s1', '']);
      const [, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['s1']);
    });

    it('recalcule les agrégats depuis les pages restantes', async () => {
      await t.repo.reconcileSessions(['s1']);
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('ss.page_count  = agg.page_count');
      expect(sql).toContain('AVG(global_score)');
    });

    it('supprime les sessions devenues vides', async () => {
      await t.repo.reconcileSessions(['s1']);
      const [sql] = t.db.execute.mock.calls[1] as [string];
      expect(sql).toContain('DELETE FROM scan_sessions');
      expect(sql).toContain('NOT EXISTS');
    });
  });

  describe('deleteOrphanSites', () => {
    it('efface les sites sans aucune session', async () => {
      await t.repo.deleteOrphanSites();
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('DELETE si FROM sites si');
      expect(sql).toContain('NOT EXISTS (SELECT 1 FROM scan_sessions ss WHERE ss.site_id = si.id)');
    });
  });

  describe('countRows', () => {
    it('n’accepte que des noms de table écrits dans le code', async () => {
      // Le type ne laisse que deux valeurs littérales : aucune entrée
      // utilisateur ne peut atteindre ce nom de table.
      await t.repo.countRows('sites');
      const [sql] = lastQueryOne(t.db);
      expect(sql).toBe('SELECT COUNT(*) AS total FROM sites');
    });
  });

  describe('ingestSession', () => {
    it('écrit site, session et pages dans UNE transaction', async () => {
      const conn = {
        query: vi.fn().mockResolvedValue([[{ id: 'site-existant' }]]),
      };
      t.db.transaction.mockImplementation((fn: (c: unknown) => Promise<void>) => fn(conn));

      await t.repo.ingestSession({
        sessionId: 's1',
        siteId: 'site-neuf',
        domain: 'exemple.fr',
        gamme: 'premium',
        epj: null,
        platform: 'duda',
        siteAlias: null,
        metadata: null,
        launchedBy: 'alice',
        durationMs: 1000,
        profileSnapshot: null,
        analyzedAt: '2026-06-04 10:00:00',
        pageCount: 1,
        avgScore: 4,
        minScore: 4,
        maxScore: 4,
        pages: [
          {
            id: 'p1',
            url: 'https://exemple.fr/',
            domain: 'exemple.fr',
            globalScore: 4,
            statusCode: 200,
            analyzedAt: '2026-06-04 10:00:00',
            durationMs: 500,
            checkSummary: '{}',
            report: '{}',
          },
        ],
      });

      expect(t.db.transaction).toHaveBeenCalledTimes(1);
      const statements = conn.query.mock.calls.map(call => (call as [string])[0]);
      expect(statements[0]).toContain('INSERT INTO sites');
      expect(statements[0]).toContain('ON DUPLICATE KEY UPDATE');
      expect(statements[2]).toContain('INSERT INTO scan_sessions');
      expect(statements[3]).toContain('INSERT INTO scan_pages');
    });

    it('RATTACHE la session au site EXISTANT, pas à l’UUID inventé', async () => {
      // `ON DUPLICATE KEY UPDATE` ne remplace pas la clé primaire : utiliser le
      // nouvel UUID violerait la clé étrangère.
      const conn = { query: vi.fn().mockResolvedValue([[{ id: 'site-existant' }]]) };
      t.db.transaction.mockImplementation((fn: (c: unknown) => Promise<void>) => fn(conn));

      await t.repo.ingestSession({
        sessionId: 's1',
        siteId: 'site-neuf',
        domain: 'exemple.fr',
        gamme: null,
        epj: null,
        platform: null,
        siteAlias: null,
        metadata: null,
        launchedBy: null,
        durationMs: null,
        profileSnapshot: null,
        analyzedAt: '2026-06-04 10:00:00',
        pageCount: 0,
        avgScore: null,
        minScore: null,
        maxScore: null,
        pages: [],
      });

      const sessionCall = conn.query.mock.calls[2] as [string, unknown[]];
      expect(sessionCall[1][1]).toBe('site-existant');
    });

    it('retombe sur l’UUID neuf si la relecture ne rend rien', async () => {
      const conn = { query: vi.fn().mockResolvedValue([[]]) };
      t.db.transaction.mockImplementation((fn: (c: unknown) => Promise<void>) => fn(conn));

      await t.repo.ingestSession({
        sessionId: 's1',
        siteId: 'site-neuf',
        domain: 'exemple.fr',
        gamme: null,
        epj: null,
        platform: null,
        siteAlias: null,
        metadata: null,
        launchedBy: null,
        durationMs: null,
        profileSnapshot: null,
        analyzedAt: '2026-06-04 10:00:00',
        pageCount: 0,
        avgScore: null,
        minScore: null,
        maxScore: null,
        pages: [],
      });

      const sessionCall = conn.query.mock.calls[2] as [string, unknown[]];
      expect(sessionCall[1][1]).toBe('site-neuf');
    });

    it('DÉCOUPE les pages en tranches plutôt qu’un INSERT géant', async () => {
      const conn = { query: vi.fn().mockResolvedValue([[{ id: 'site' }]]) };
      t.db.transaction.mockImplementation((fn: (c: unknown) => Promise<void>) => fn(conn));

      const pages = Array.from({ length: 450 }, (_, i) => ({
        id: `p${i}`,
        url: `https://exemple.fr/${i}`,
        domain: 'exemple.fr',
        globalScore: 4,
        statusCode: 200,
        analyzedAt: '2026-06-04 10:00:00',
        durationMs: 10,
        checkSummary: '{}',
        report: null,
      }));

      await t.repo.ingestSession({
        sessionId: 's1',
        siteId: 'site',
        domain: 'exemple.fr',
        gamme: null,
        epj: null,
        platform: null,
        siteAlias: null,
        metadata: null,
        launchedBy: null,
        durationMs: null,
        profileSnapshot: null,
        analyzedAt: '2026-06-04 10:00:00',
        pageCount: 450,
        avgScore: 4,
        minScore: 4,
        maxScore: 4,
        pages,
      });

      const pageInserts = conn.query.mock.calls
        .map(call => (call as [string])[0])
        .filter(sql => sql.includes('INSERT INTO scan_pages'));
      expect(pageInserts).toHaveLength(3);
    });
  });
});
