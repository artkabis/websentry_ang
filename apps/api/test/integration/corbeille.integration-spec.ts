import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../src/config/app-config.service.js';
import type { DatabaseService } from '../../src/database/database.service.js';
import { ScanTrashRepository } from '../../src/database/repositories/scan-trash.repository.js';
import type { AuditService } from '../../src/audit/audit.service.js';
import { ScanTrashService } from '../../src/scans/scan-trash.service.js';
import type { ScanActor } from '../../src/scans/scans.service.js';
import { appliquerSchema, compte, ouvrir, viderTables } from './base.js';

/**
 * Corbeille des scans, aller-retour complet sur un vrai moteur.
 *
 * C'est ici que la promesse du module se vérifie ou tombe : archiver, supprimer,
 * puis retrouver l'historique à l'identique. Aucun double ne peut l'établir —
 * il faudrait qu'il reproduise les cascades, la clé d'identité générée, la
 * contrainte d'unicité et le stockage binaire des rapports.
 */
describe('corbeille des scans sur MariaDB', () => {
  let db: DatabaseService;
  let repo: ScanTrashRepository;
  let service: ScanTrashService;
  let audit: { record: ReturnType<typeof vi.fn> };

  const ACTOR: ScanActor = {
    actorId: null,
    actorName: 'alice',
    ipAddress: '203.0.113.7',
  };

  beforeAll(async () => {
    db = await ouvrir();
    await appliquerSchema(db);
    repo = new ScanTrashRepository(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await viderTables(db);
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new ScanTrashService(
      repo,
      audit as unknown as AuditService,
      {
        retention: { enabled: true, batchSize: 500, trashRetentionDays: 30 },
      } as unknown as AppConfigService,
    );
  });

  /** Un site, une session et deux pages — dont une avec un rapport compressé. */
  async function historique(
    domain = 'exemple.fr',
    gamme: string | null = 'premium',
  ): Promise<{ siteId: string; sessionId: string; pageIds: string[] }> {
    const siteId = randomUUID();
    const sessionId = randomUUID();
    const pageAccueil = randomUUID();
    const pageContact = randomUUID();

    await db.execute(
      `INSERT INTO sites (id, domain, gamme, epj, site_alias, metadata, first_seen, last_seen)
       VALUES (?, ?, ?, 'EPJ-1', 'Exemple', '{"cms":"wordpress"}', '2026-01-01 08:00:00', '2026-01-02 08:00:00')`,
      [siteId, domain, gamme],
    );
    await db.execute(
      `INSERT INTO scan_sessions
         (id, site_id, gamme, epj, platform, page_count, avg_score, min_score, max_score,
          analyzed_at, duration_ms, launched_by, profile_snapshot)
       VALUES (?, ?, ?, 'EPJ-1', 'wordpress', 2, 4.25, 3.50, 5.00,
               '2026-01-02 08:00:00', 1234, 'alice', '{"seuil":4}')`,
      [sessionId, siteId, gamme],
    );
    await db.execute(
      `INSERT INTO scan_pages
         (id, session_id, url, domain, global_score, status_code, analyzed_at,
          duration_ms, check_summary, report)
       VALUES (?, ?, 'https://exemple.fr/', ?, 4.50, 200, '2026-01-02 08:00:00',
               600, '{"seo":"ok"}', '{"detail":"clair"}')`,
      [pageAccueil, sessionId, domain],
    );
    // La seconde page porte un rapport COMPRESSÉ : c'est le cas que la
    // sérialisation naïve dénaturerait sans qu'on le voie.
    await db.execute(
      `INSERT INTO scan_pages
         (id, session_id, url, domain, global_score, status_code, analyzed_at,
          duration_ms, check_summary, report_gz, is_compressed)
       VALUES (?, ?, 'https://exemple.fr/contact', ?, 3.50, 200, '2026-01-02 08:00:00',
               400, '{"seo":"ko"}', ?, 1)`,
      [pageContact, sessionId, domain, gzipSync('{"detail":"compressé"}')],
    );

    return { siteId, sessionId, pageIds: [pageAccueil, pageContact] };
  }

  const compterHistorique = () =>
    db.queryOne<RowDataPacket & { sites: number; sessions: number; pages: number }>(
      `SELECT (SELECT COUNT(*) FROM sites)         AS sites,
              (SELECT COUNT(*) FROM scan_sessions) AS sessions,
              (SELECT COUNT(*) FROM scan_pages)    AS pages`,
    );

  describe('aller-retour', () => {
    it('RESTAURE un site supprimé à l’identique, rapports compris', async () => {
      const { siteId, sessionId, pageIds } = await historique();
      const avant = await db.query<RowDataPacket>('SELECT * FROM scan_pages ORDER BY url ASC');

      const trashId = await service.archiverSite('exemple.fr', 'premium', ACTOR);
      expect(trashId).not.toBeNull();

      // La suppression réelle, cascades comprises.
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);
      expect(await compterHistorique()).toMatchObject({ sites: 0, sessions: 0, pages: 0 });

      const bilan = await service.restaurer(trashId!, ACTOR);

      expect(bilan).toEqual({ sites: 1, sessions: 1, pages: 2, skippedSessions: 0 });
      expect(await compterHistorique()).toMatchObject({ sites: 1, sessions: 1, pages: 2 });

      const apres = await db.query<RowDataPacket>('SELECT * FROM scan_pages ORDER BY url ASC');
      // À l'identique signifie à l'identique : toutes les colonnes, y compris le
      // rapport binaire et le résumé JSON.
      expect(apres).toEqual(avant);
      expect(apres.map(p => p.id).sort()).toEqual([...pageIds].sort());

      const session = await db.queryOne<RowDataPacket & { site_id: string; launched_by: string }>(
        'SELECT * FROM scan_sessions WHERE id = ?',
        [sessionId],
      );
      expect(session?.site_id).toBe(siteId);
      expect(session?.launched_by).toBe('alice');
    });

    it('VIDE l’entrée de la corbeille après restauration', async () => {
      const { siteId } = await historique();
      const trashId = await service.archiverSite('exemple.fr', 'premium', ACTOR);
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      await service.restaurer(trashId!, ACTOR);

      expect(await repo.trouver(trashId!)).toBeNull();
    });

    it('RESTAURE un domaine entier, tous ses sites', async () => {
      const a = await historique('multi.fr', 'premium');
      const b = await historique('multi.fr', 'standard');

      const trashId = await service.archiver({ scope: 'domain', domain: 'multi.fr' }, ACTOR);
      await db.execute('DELETE FROM sites WHERE domain = ?', ['multi.fr']);

      const bilan = await service.restaurer(trashId!, ACTOR);

      expect(bilan.sites).toBe(2);
      expect(bilan.sessions).toBe(2);
      expect(bilan.pages).toBe(4);
      const ids = await db.query<RowDataPacket & { id: string }>('SELECT id FROM sites');
      expect(ids.map(l => l.id).sort()).toEqual([a.siteId, b.siteId].sort());
    });
  });

  describe('le site a été rescanné depuis', () => {
    it('RÉUTILISE le site recréé au lieu de violer son unicité', async () => {
      // Sans cela, la restauration échouerait sur `uniq_identity` — et écraser
      // la ligne récente effacerait un scan que personne n'a demandé de
      // supprimer.
      const { siteId } = await historique();
      const trashId = await service.archiverSite('exemple.fr', 'premium', ACTOR);
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      // Un nouveau scan recrée le même site, avec un autre identifiant.
      const nouveauSite = randomUUID();
      await db.execute(
        `INSERT INTO sites (id, domain, gamme, first_seen, last_seen)
         VALUES (?, 'exemple.fr', 'premium', NOW(), NOW())`,
        [nouveauSite],
      );

      const bilan = await service.restaurer(trashId!, ACTOR);

      expect(bilan.sites).toBe(0);
      expect(bilan.sessions).toBe(1);
      const sites = await db.query<RowDataPacket & { id: string }>('SELECT id FROM sites');
      expect(sites.map(s => s.id)).toEqual([nouveauSite]);
      // La session restaurée est rattachée au site EXISTANT.
      const session = await db.queryOne<RowDataPacket & { site_id: string }>(
        'SELECT site_id FROM scan_sessions',
      );
      expect(session?.site_id).toBe(nouveauSite);
    });

    it('IGNORE une session déjà revenue, sans l’écraser', async () => {
      // Le rescan est plus récent que l'archive : l'écraser ferait perdre une
      // donnée plus fraîche que celle qu'on restaure.
      const { siteId, sessionId } = await historique();
      const trashId = await service.archiverSite('exemple.fr', 'premium', ACTOR);
      await db.execute('DELETE FROM scan_pages WHERE session_id = ?', [sessionId]);
      await db.execute('UPDATE scan_sessions SET launched_by = ?, avg_score = 1.00 WHERE id = ?', [
        'bob',
        sessionId,
      ]);

      const bilan = await service.restaurer(trashId!, ACTOR);

      expect(bilan.skippedSessions).toBe(1);
      expect(bilan.sessions).toBe(0);
      // Les pages de l'archive n'ont pas été rattachées à la session en place :
      // mélanger deux audits distincts serait pire que de ne rien restaurer.
      expect(bilan.pages).toBe(0);
      const session = await db.queryOne<RowDataPacket & { launched_by: string }>(
        'SELECT launched_by FROM scan_sessions WHERE id = ?',
        [sessionId],
      );
      expect(session?.launched_by).toBe('bob');
      expect(siteId).toBeTruthy();
    });
  });

  describe('dérive du schéma', () => {
    it('capture TOUTES les colonnes insérables, sans liste écrite à la main', async () => {
      // L'invariant qui rend la corbeille auto-suffisante : une colonne ajoutée
      // plus tard à l'historique doit se retrouver dans l'instantané sans que
      // personne ne pense à la déclarer. Une colonne GÉNÉRÉE, elle, doit en être
      // absente — MariaDB refuse qu'on lui affecte une valeur.
      await historique();
      const instantane = await repo.capturer([], []);
      expect(instantane.sites).toEqual([]);

      const { siteId, sessionId } = await historique('drift.fr', null);
      const capture = await repo.capturer([siteId], [sessionId]);

      const attendues = async (table: string) => {
        const lignes = await db.query<RowDataPacket & { c: string; g: string }>(
          `SELECT column_name AS c, generation_expression AS g
             FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?`,
          [table],
        );
        return {
          toutes: lignes.map(l => l.c).sort(),
          inserables: lignes
            .filter(l => l.g === '')
            .map(l => l.c)
            .sort(),
        };
      };

      const sites = await attendues('sites');
      // L'instantané capture tout, colonne générée comprise : c'est la
      // restauration qui la filtre, pas la capture.
      expect(Object.keys(capture.sites[0] ?? {}).sort()).toEqual(sites.toutes);
      expect(sites.toutes).toContain('identity_key');
      expect(sites.inserables).not.toContain('identity_key');

      const sessions = await attendues('scan_sessions');
      expect(Object.keys(capture.sessions[0] ?? {}).sort()).toEqual(sessions.toutes);

      const pages = await attendues('scan_pages');
      expect(Object.keys(capture.pages[0] ?? {}).sort()).toEqual(pages.toutes);
    });
  });

  describe('purge', () => {
    it('efface les entrées ÉCHUES et garde les autres', async () => {
      const { siteId } = await historique();
      const vivante = await service.archiverSite('exemple.fr', 'premium', ACTOR);
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      const echue = await historique('echue.fr', null);
      const aPurger = await service.archiverSite('echue.fr', null, ACTOR);
      await db.execute('UPDATE scan_trash SET purge_after = ? WHERE id = ?', [
        '2020-01-01 00:00:00',
        aPurger,
      ]);

      await expect(service.purgerEchues()).resolves.toBe(1);

      expect(await repo.trouver(aPurger!)).toBeNull();
      expect(await repo.trouver(vivante!)).not.toBeNull();
      expect(echue.siteId).toBeTruthy();
    });

    it('rend la volumétrie que la supervision affiche', async () => {
      const { siteId } = await historique();
      await service.archiverSite('exemple.fr', 'premium', ACTOR);
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      const volume = await service.volumetrie();

      expect(volume.entrees).toBe(1);
      expect(volume.octets).toBeGreaterThan(0);
      expect(volume.echues).toBe(0);
    });
  });

  describe('l’auteur de la suppression', () => {
    it('SURVIT au départ du compte, sans emporter l’entrée', async () => {
      // `SET NULL` et non `CASCADE` : la corbeille appartient à l'équipe, pas à
      // celui qui a cliqué.
      const acteur = await compte(db, randomUUID(), { username: 'partie' });
      const { siteId } = await historique();
      const trashId = await service.archiverSite('exemple.fr', 'premium', {
        actorId: acteur,
        actorName: 'partie',
        ipAddress: null,
      });
      await db.execute('DELETE FROM sites WHERE id = ?', [siteId]);

      await db.execute('DELETE FROM users WHERE id = ?', [acteur]);

      const entree = await repo.trouver(trashId!);
      expect(entree).not.toBeNull();
      expect(entree?.deleted_by).toBeNull();
      // Le nom reste : sans lui, l'entrée n'aurait plus d'auteur affichable.
      expect(entree?.deleted_by_name).toBe('partie');
    });
  });
});
