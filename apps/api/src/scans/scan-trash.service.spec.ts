import { gzipSync } from 'node:zlib';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ScanTrashRepository } from '../database/repositories/scan-trash.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ScanTrashService } from './scan-trash.service.js';
import type { ScanActor } from './scans.service.js';

const ACTOR: ScanActor = {
  actorId: '11111111-1111-4111-8111-111111111111',
  actorName: 'alice',
  ipAddress: '203.0.113.7',
};

const ENTREE = {
  id: '22222222-2222-4222-8222-222222222222',
  scope: 'site' as const,
  domain: 'exemple.fr',
  gamme: 'premium',
  label: 'exemple.fr — premium',
  session_count: 2,
  page_count: 5,
  payload_bytes: 4096,
  deleted_at: '2026-01-01 10:00:00',
  deleted_by: ACTOR.actorId,
  deleted_by_name: 'alice',
  purge_after: '2026-01-31 10:00:00',
};

/** Un instantané minimal, compressé comme la base le stocke. */
function instantaneGz(sites = 1, sessions = 1, pages = 2): Buffer {
  return gzipSync(
    JSON.stringify({
      sites: Array.from({ length: sites }, (_, i) => ({ id: `s${i}`, domain: 'exemple.fr' })),
      sessions: Array.from({ length: sessions }, (_, i) => ({ id: `se${i}`, site_id: 's0' })),
      pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, session_id: 'se0' })),
    }),
  );
}

function build(options: { available?: boolean } = {}) {
  const repo = {
    available: options.available ?? true,
    capturer: vi
      .fn()
      .mockResolvedValue({ sites: [{ id: 's0' }], sessions: [{ id: 'se0' }], pages: [] }),
    siteParIdentite: vi.fn().mockResolvedValue('s0'),
    sitesDuDomaine: vi.fn().mockResolvedValue(['s0', 's1']),
    sessionsDesSites: vi.fn().mockResolvedValue(['se0']),
    ajouter: vi.fn().mockResolvedValue(undefined),
    lister: vi.fn().mockResolvedValue([ENTREE]),
    compter: vi.fn().mockResolvedValue(1),
    trouver: vi.fn().mockResolvedValue(ENTREE),
    instantaneCompresse: vi.fn().mockResolvedValue(instantaneGz()),
    supprimer: vi.fn().mockResolvedValue(true),
    purger: vi.fn().mockResolvedValue(3),
    volumetrie: vi.fn().mockResolvedValue({ entrees: 2, octets: 8192, echues: 1 }),
    restaurer: vi.fn().mockResolvedValue({ sites: 1, sessions: 1, pages: 2, skippedSessions: 0 }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const config = { retention: { enabled: true, batchSize: 500, trashRetentionDays: 30 } };

  const service = new ScanTrashService(
    repo as unknown as ScanTrashRepository,
    audit as unknown as AuditService,
    config as unknown as AppConfigService,
  );
  return { service, repo, audit, config };
}

describe('ScanTrashService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('archivage', () => {
    it('capture le site ET toutes ses sessions', async () => {
      const id = await t.service.archiverSite('exemple.fr', 'premium', ACTOR);

      expect(t.repo.sessionsDesSites).toHaveBeenCalledWith(['s0']);
      expect(t.repo.capturer).toHaveBeenCalledWith(['s0'], ['se0']);
      expect(id).toBeTruthy();
    });

    it('capture TOUS les sites d’un domaine', async () => {
      await t.service.archiver({ scope: 'domain', domain: 'exemple.fr' }, ACTOR);

      expect(t.repo.capturer).toHaveBeenCalledWith(['s0', 's1'], ['se0']);
    });

    it('n’attache AUCUNE gamme à une entrée de domaine', async () => {
      // Plusieurs sites partagent un domaine, chacun avec la sienne.
      await t.service.archiver({ scope: 'domain', domain: 'exemple.fr' }, ACTOR);

      expect(t.repo.ajouter).toHaveBeenCalledWith(
        expect.objectContaining({ gamme: null, label: 'exemple.fr' }),
      );
    });

    it('n’archive RIEN quand le site n’existe pas', async () => {
      // Une entrée creuse serait du tri en plus pour l'utilisateur, sans aucune
      // contrepartie : la suppression qui suit ne touchera rien non plus.
      t.repo.siteParIdentite.mockResolvedValue(null);

      await expect(t.service.archiverSite('absent.fr', null, ACTOR)).resolves.toBeNull();
      expect(t.repo.ajouter).not.toHaveBeenCalled();
    });

    it('n’archive RIEN quand la cible est vide', async () => {
      t.repo.sitesDuDomaine.mockResolvedValue([]);
      t.repo.sessionsDesSites.mockResolvedValue([]);

      await expect(
        t.service.archiver({ scope: 'domain', domain: 'vide.fr' }, ACTOR),
      ).resolves.toBeNull();
      expect(t.repo.ajouter).not.toHaveBeenCalled();
    });

    it('COMPRESSE l’instantané et retient sa taille d’origine', async () => {
      t.repo.capturer.mockResolvedValue({
        sites: [{ id: 's0', domain: 'exemple.fr' }],
        sessions: [{ id: 'se0', site_id: 's0' }],
        pages: [{ id: 'p0', session_id: 'se0', report: 'x'.repeat(5000) }],
      });

      await t.service.archiverSite('exemple.fr', 'premium', ACTOR);

      const ecrit = t.repo.ajouter.mock.calls[0]?.[0] as {
        payloadGz: Buffer;
        payloadBytes: number;
        pageCount: number;
      };
      // La compression est la contrepartie du doublon de stockage : sans elle,
      // la corbeille pèserait autant que ce qu'elle remplace.
      expect(ecrit.payloadGz.length).toBeLessThan(ecrit.payloadBytes);
      expect(ecrit.payloadBytes).toBeGreaterThan(5000);
      expect(ecrit.pageCount).toBe(1);
    });

    it('DATE l’échéance depuis le réglage de rétention', async () => {
      t.config.retention.trashRetentionDays = 7;

      await t.service.archiverSite('exemple.fr', 'premium', ACTOR);

      expect(t.repo.ajouter).toHaveBeenCalledWith(expect.objectContaining({ purgeAfterDays: 7 }));
    });

    it('RETIENT qui a supprimé', async () => {
      await t.service.archiverSite('exemple.fr', 'premium', ACTOR);

      expect(t.repo.ajouter).toHaveBeenCalledWith(
        expect.objectContaining({ deletedBy: ACTOR.actorId, deletedByName: 'alice' }),
      );
    });
  });

  describe('lecture', () => {
    it('rend les entrées et le total', async () => {
      const page = await t.service.lister({ page: 1, limit: 25 });

      expect(page.total).toBe(1);
      expect(page.items[0]?.label).toBe('exemple.fr — premium');
      expect(page.items[0]?.pageCount).toBe(5);
    });

    it('N’INTERROGE PAS la liste quand le total est nul', async () => {
      // La requête rendrait un tableau vide et coûterait le même filtre.
      t.repo.compter.mockResolvedValue(0);

      await t.service.lister({ page: 1, limit: 25 });

      expect(t.repo.lister).not.toHaveBeenCalled();
    });

    it('calcule l’offset depuis la page demandée', async () => {
      await t.service.lister({ page: 3, limit: 10 });

      expect(t.repo.lister).toHaveBeenCalledWith(expect.anything(), 10, 20);
    });

    it('exporte un instantané VERSIONNÉ', async () => {
      // Sans numéro de format, un export relu dans deux ans ne saurait pas
      // comment se lire.
      const sortie = await t.service.exporter(ENTREE.id);

      expect(sortie.format).toBe(1);
      expect(sortie.scope).toBe('site');
      expect(sortie.pages).toHaveLength(2);
    });

    it('lève 404 sur une entrée inconnue', async () => {
      t.repo.trouver.mockResolvedValue(null);

      await expect(t.service.exporter(ENTREE.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restauration', () => {
    it('réinsère, puis RETIRE l’entrée de la corbeille', async () => {
      // Ce qui reste dans la corbeille est, par définition, ce qui peut encore
      // être restauré.
      const resultat = await t.service.restaurer(ENTREE.id, ACTOR);

      expect(resultat).toEqual({ sites: 1, sessions: 1, pages: 2, skippedSessions: 0 });
      expect(t.repo.supprimer).toHaveBeenCalledWith(ENTREE.id);
    });

    it('JOURNALISE la restauration avec son bilan', async () => {
      await t.service.restaurer(ENTREE.id, ACTOR);

      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'scans.trash_restore',
          actorId: ACTOR.actorId,
          details: expect.objectContaining({ trashId: ENTREE.id, sessions: 1, pages: 2 }),
        }),
      );
    });

    it('SIGNALE les sessions ignorées plutôt que de taire une reprise partielle', async () => {
      t.repo.restaurer.mockResolvedValue({
        sites: 0,
        sessions: 0,
        pages: 0,
        skippedSessions: 2,
      });

      const resultat = await t.service.restaurer(ENTREE.id, ACTOR);

      expect(resultat.skippedSessions).toBe(2);
    });

    it('lève 404 quand l’entrée a disparu entre-temps', async () => {
      t.repo.trouver.mockResolvedValue(null);

      await expect(t.service.restaurer(ENTREE.id, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.repo.restaurer).not.toHaveBeenCalled();
    });
  });

  describe('purge', () => {
    it('efface l’entrée et JOURNALISE ce qui est perdu', async () => {
      await t.service.purger(ENTREE.id, ACTOR);

      expect(t.repo.supprimer).toHaveBeenCalledWith(ENTREE.id);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'scans.trash_purge',
          details: expect.objectContaining({ sessions: 2, pages: 5 }),
        }),
      );
    });

    it('lève 404 sur une entrée inconnue, sans rien effacer', async () => {
      t.repo.trouver.mockResolvedValue(null);

      await expect(t.service.purger(ENTREE.id, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.repo.supprimer).not.toHaveBeenCalled();
    });

    it('vide les entrées échues au passage de rétention', async () => {
      await expect(t.service.purgerEchues()).resolves.toBe(3);
      expect(t.repo.purger).toHaveBeenCalledWith(500);
    });

    it('ne vide RIEN quand la rétention est désactivée', async () => {
      t.config.retention.enabled = false;

      await expect(t.service.purgerEchues()).resolves.toBe(0);
      expect(t.repo.purger).not.toHaveBeenCalled();
    });
  });

  describe('base absente', () => {
    it('refuse chaque opération par un 503', async () => {
      const off = build({ available: false });

      await expect(off.service.lister({ page: 1, limit: 25 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(off.service.restaurer(ENTREE.id, ACTOR)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(off.service.purger(ENTREE.id, ACTOR)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(off.service.exporter(ENTREE.id)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(off.service.archiverSite('x.fr', null, ACTOR)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('rend 0 au passage de rétention, sans lever', async () => {
      // Le travail de fond ne doit pas faire tomber l'API parce que la base est
      // momentanément absente.
      const off = build({ available: false });

      await expect(off.service.purgerEchues()).resolves.toBe(0);
    });
  });
});
