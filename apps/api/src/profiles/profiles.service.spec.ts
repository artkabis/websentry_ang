import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  DEFAULT_PROFILE,
  PROFILE_EXPORT_VERSION,
  defaultAnalysisSettings,
} from '@websentry/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { ProfileRepository, ProfileRow } from '../database/repositories/profile.repository.js';
import {
  DefaultProfileProtectedError,
  ProfileNotFoundError,
  ProfileVersionConflictError,
} from './profile.errors.js';
import { ProfilesService, type WriteContext } from './profiles.service.js';

const CTX: WriteContext = { actorId: 'u1', actorName: 'alice', ipAddress: '203.0.113.10' };

function row(over: Partial<Omit<ProfileRow, 'constructor'>> = {}): ProfileRow {
  return {
    gamme: 'premium',
    label: 'Premium',
    description: null,
    settings: defaultAnalysisSettings(),
    version: 3,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-02 00:00:00',
    updated_by: 'alice',
    ...over,
  } as ProfileRow;
}

function build(available = true) {
  const repo = {
    available,
    list: vi.fn().mockResolvedValue([]),
    findByGamme: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(true),
    updateWithVersion: vi.fn().mockResolvedValue(true),
    delete: vi.fn().mockResolvedValue(true),
    currentVersion: vi.fn().mockResolvedValue(null),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new ProfilesService(
    repo as unknown as ProfileRepository,
    audit as unknown as AuditService,
  );
  return { service, repo, audit };
}

describe('ProfilesService', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('normalize', () => {
    it.each([
      ['PREMIUM', 'premium'],
      ['START Plus!', 'startplus'],
      ['../../etc/passwd', 'etcpasswd'],
    ])('normalise %s en %s', (raw, expected) => {
      expect(t.service.normalize(raw)).toBe(expected);
    });

    it('REFUSE une gamme qui ne laisse rien après normalisation', () => {
      // Un profil sans identifiant serait introuvable et insupprimable.
      expect(() => t.service.normalize('!!!')).toThrow(BadRequestException);
      expect(() => t.service.normalize('...')).toThrow(BadRequestException);
    });
  });

  describe('indisponibilité', () => {
    it.each([
      ['list', (s: ProfilesService) => s.list()],
      ['get', (s: ProfilesService) => s.get('premium')],
      [
        'save',
        (s: ProfilesService) => s.save('premium', { settings: defaultAnalysisSettings() }, CTX),
      ],
      ['remove', (s: ProfilesService) => s.remove('premium', CTX)],
      ['resolveSettings', (s: ProfilesService) => s.resolveSettings('premium')],
    ])('répond 503 sur %s quand la base est absente', async (_label, call) => {
      const offline = build(false);
      await expect(call(offline.service)).rejects.toThrow(ServiceUnavailableException);
    });

    it('ne tente pas de créer le profil de repli sans base', async () => {
      const offline = build(false);
      await offline.service.ensureDefaultProfile();
      expect(offline.repo.create).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('projette la ligne en profil complet', async () => {
      t.repo.findByGamme.mockResolvedValue(row());
      const profile = await t.service.get('PREMIUM');

      expect(profile).toMatchObject({
        profile: 'premium',
        label: 'Premium',
        description: null,
        version: 3,
        updatedBy: 'alice',
      });
      expect(profile.settings.meta.title).toEqual({ min: 50, max: 65 });
    });

    it('lève quand la gamme n’existe pas', async () => {
      t.repo.findByGamme.mockResolvedValue(null);
      await expect(t.service.get('inconnue')).rejects.toThrow(ProfileNotFoundError);
    });

    it('décode une colonne JSON rendue sous forme de chaîne', async () => {
      // Selon la configuration du driver, MariaDB rend un objet ou du texte.
      t.repo.findByGamme.mockResolvedValue(
        row({ settings: JSON.stringify(defaultAnalysisSettings()) }),
      );
      const profile = await t.service.get('premium');
      expect(profile.settings.content.minWords).toBe(300);
    });

    it('retombe sur les défauts si la ligne est invalide en base', async () => {
      // Une ligne écrite par une version antérieure du schéma, ou modifiée à la
      // main, ne doit pas se propager telle quelle jusqu'au moteur d'analyse.
      t.repo.findByGamme.mockResolvedValue(row({ settings: { inconnu: 'valeur' } }));
      const profile = await t.service.get('premium');
      expect(profile.settings.meta.title).toEqual({ min: 50, max: 65 });
    });

    it('retombe sur les défauts si la colonne JSON est illisible', async () => {
      t.repo.findByGamme.mockResolvedValue(row({ settings: '{ ceci n est pas du json' }));
      const profile = await t.service.get('premium');
      expect(profile.settings.content.minWords).toBe(300);
    });
  });

  describe('resolveSettings', () => {
    it('rend le profil de la gamme quand il existe', async () => {
      t.repo.findByGamme.mockResolvedValue(row({ gamme: 'premium' }));
      await expect(t.service.resolveSettings('PREMIUM')).resolves.toMatchObject({
        profile: 'premium',
      });
    });

    it('RETOMBE sur default quand la gamme est inconnue — un scan ne doit pas échouer pour ça', async () => {
      t.repo.findByGamme.mockImplementation((g: string) =>
        Promise.resolve(g === DEFAULT_PROFILE ? row({ gamme: DEFAULT_PROFILE }) : null),
      );
      await expect(t.service.resolveSettings('inexistante')).resolves.toMatchObject({
        profile: DEFAULT_PROFILE,
      });
    });

    it('retombe sur default quand aucune gamme n’est fournie', async () => {
      t.repo.findByGamme.mockResolvedValue(row({ gamme: DEFAULT_PROFILE }));
      const resolved = await t.service.resolveSettings(null);
      expect(resolved.profile).toBe(DEFAULT_PROFILE);
      expect(t.repo.findByGamme).toHaveBeenCalledWith(DEFAULT_PROFILE);
    });

    it('retombe sur default quand la gamme se normalise en chaîne vide', async () => {
      // Ici on ne lève PAS : le chemin d'analyse doit rester tolérant.
      t.repo.findByGamme.mockResolvedValue(row({ gamme: DEFAULT_PROFILE }));
      await expect(t.service.resolveSettings('!!!')).resolves.toMatchObject({
        profile: DEFAULT_PROFILE,
      });
    });

    it('sert les défauts du schéma si même default a disparu', async () => {
      t.repo.findByGamme.mockResolvedValue(null);
      const resolved = await t.service.resolveSettings('premium');
      expect(resolved.profile).toBe(DEFAULT_PROFILE);
      expect(resolved.settings.meta.title).toEqual({ min: 50, max: 65 });
    });
  });

  describe('save — création', () => {
    it('crée quand la gamme n’existe pas', async () => {
      t.repo.currentVersion.mockResolvedValue(null);
      t.repo.findByGamme.mockResolvedValue(row({ gamme: 'nouvelle' }));

      await t.service.save('nouvelle', { settings: defaultAnalysisSettings() }, CTX);

      expect(t.repo.create).toHaveBeenCalled();
      expect(t.repo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('dérive un libellé capitalisé quand aucun n’est fourni', async () => {
      t.repo.currentVersion.mockResolvedValue(null);
      t.repo.findByGamme.mockResolvedValue(row());

      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect(t.repo.create).toHaveBeenCalledWith(
        'premium',
        'Premium',
        null,
        expect.anything(),
        'alice',
      );
    });

    it('bascule en mise à jour si la création perd la course', async () => {
      // Un autre appelant a créé la gamme entre notre lecture de version et
      // l'insertion : ce n'est pas une erreur pour l'utilisateur.
      t.repo.currentVersion.mockResolvedValue(null);
      t.repo.create.mockResolvedValue(false);
      t.repo.findByGamme.mockResolvedValue(row());

      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect(t.repo.updateWithVersion).toHaveBeenCalled();
    });

    it('journalise la création', async () => {
      t.repo.currentVersion.mockResolvedValue(null);
      t.repo.findByGamme.mockResolvedValue(row());

      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'profile.created', actorName: 'alice' }),
      );
    });
  });

  describe('save — mise à jour et verrouillage optimiste', () => {
    beforeEach(() => {
      t.repo.currentVersion.mockResolvedValue(3);
      t.repo.findByGamme.mockResolvedValue(row());
    });

    it('transmet la version attendue au repository', async () => {
      await t.service.save(
        'premium',
        { settings: defaultAnalysisSettings(), expectedVersion: 3 },
        CTX,
      );
      const call = t.repo.updateWithVersion.mock.calls[0] as unknown[];
      expect(call[5]).toBe(3);
    });

    it('écrase sans condition quand aucune version n’est attendue', async () => {
      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      const call = t.repo.updateWithVersion.mock.calls[0] as unknown[];
      expect(call[5]).toBeNull();
    });

    it('LÈVE un conflit quand la version ne correspond plus', async () => {
      t.repo.updateWithVersion.mockResolvedValue(false);
      t.repo.currentVersion.mockResolvedValueOnce(3).mockResolvedValueOnce(9);

      const err = await t.service
        .save('premium', { settings: defaultAnalysisSettings(), expectedVersion: 3 }, CTX)
        .catch(e => e);

      expect(err).toBeInstanceOf(ProfileVersionConflictError);
      expect((err as ProfileVersionConflictError).currentVersion).toBe(9);
      expect((err as ProfileVersionConflictError).expectedVersion).toBe(3);
    });

    it('CONSERVE le libellé existant quand il n’est pas fourni', async () => {
      // Une écriture partielle ne doit pas effacer une métadonnée qu'on n'a pas
      // voulu toucher.
      t.repo.findByGamme.mockResolvedValue(row({ label: 'Libellé métier' }));
      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect((t.repo.updateWithVersion.mock.calls[0] as unknown[])[1]).toBe('Libellé métier');
    });

    it('conserve la description existante quand elle n’est pas fournie', async () => {
      t.repo.findByGamme.mockResolvedValue(row({ description: 'Description métier' }));
      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect((t.repo.updateWithVersion.mock.calls[0] as unknown[])[2]).toBe('Description métier');
    });

    it('EFFACE la description quand null est explicitement fourni', async () => {
      // `null` est un effacement voulu, `undefined` une absence de consigne :
      // les confondre rendrait l'effacement impossible.
      t.repo.findByGamme.mockResolvedValue(row({ description: 'Ancienne' }));
      await t.service.save(
        'premium',
        { settings: defaultAnalysisSettings(), description: null },
        CTX,
      );
      expect((t.repo.updateWithVersion.mock.calls[0] as unknown[])[2]).toBeNull();
    });

    it('journalise la mise à jour avec la version de départ', async () => {
      await t.service.save('premium', { settings: defaultAnalysisSettings() }, CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'profile.updated',
          details: { gamme: 'premium', fromVersion: 3 },
        }),
      );
    });

    it('re-valide les réglages même s’ils viennent d’un pipe déjà validé', async () => {
      // Le service est aussi appelé depuis l'import, dont la source est un fichier.
      await expect(
        t.service.save('premium', { settings: { inconnu: true } as never }, CTX),
      ).rejects.toThrow();
    });
  });

  describe('remove', () => {
    it('supprime une gamme ordinaire', async () => {
      await t.service.remove('premium', CTX);
      expect(t.repo.delete).toHaveBeenCalledWith('premium');
    });

    it('PROTÈGE le profil de repli', async () => {
      await expect(t.service.remove(DEFAULT_PROFILE, CTX)).rejects.toThrow(
        DefaultProfileProtectedError,
      );
      expect(t.repo.delete).not.toHaveBeenCalled();
    });

    it('protège le repli même écrit en majuscules', async () => {
      await expect(t.service.remove('DEFAULT', CTX)).rejects.toThrow(DefaultProfileProtectedError);
    });

    it('lève quand la gamme n’existe pas', async () => {
      t.repo.delete.mockResolvedValue(false);
      await expect(t.service.remove('inconnue', CTX)).rejects.toThrow(ProfileNotFoundError);
    });

    it('journalise la suppression', async () => {
      await t.service.remove('premium', CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'profile.deleted' }),
      );
    });
  });

  describe('reset', () => {
    it('réécrit les réglages par défaut et journalise', async () => {
      t.repo.currentVersion.mockResolvedValue(2);
      t.repo.findByGamme.mockResolvedValue(row());

      await t.service.reset('premium', CTX);

      const written = (t.repo.updateWithVersion.mock.calls[0] as unknown[])[3] as {
        content: { minWords: number };
      };
      expect(written.content.minWords).toBe(300);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'profile.reset' }),
      );
    });
  });

  describe('export', () => {
    it('produit une enveloppe autodescriptive', async () => {
      t.repo.findByGamme.mockResolvedValue(row({ version: 7, label: 'Premium' }));
      const payload = await t.service.export('premium');

      expect(payload).toMatchObject({
        formatVersion: PROFILE_EXPORT_VERSION,
        profile: 'premium',
        label: 'Premium',
        sourceVersion: 7,
      });
      expect(new Date(payload.exportedAt).toString()).not.toBe('Invalid Date');
    });

    it('lève pour une gamme inexistante', async () => {
      t.repo.findByGamme.mockResolvedValue(null);
      await expect(t.service.export('inconnue')).rejects.toThrow(ProfileNotFoundError);
    });
  });

  describe('import', () => {
    const payload = {
      formatVersion: PROFILE_EXPORT_VERSION as 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      profile: 'premium',
      label: 'Premium importé',
      description: 'Venu d’un autre environnement',
      sourceVersion: 12,
      settings: defaultAnalysisSettings(),
    };

    beforeEach(() => {
      t.repo.currentVersion.mockResolvedValue(null);
      t.repo.findByGamme.mockResolvedValue(row());
    });

    it('écrit dans la gamme de DESTINATION, pas celle du fichier', async () => {
      // Laisser le fichier choisir sa cible ouvrirait un écrasement non voulu.
      await t.service.import('start', payload, undefined, CTX);
      expect(t.repo.create).toHaveBeenCalledWith(
        'start',
        'Premium importé',
        expect.any(String),
        expect.anything(),
        'alice',
      );
    });

    it('reprend le libellé et la description de l’enveloppe', async () => {
      await t.service.import('start', payload, undefined, CTX);
      const call = t.repo.create.mock.calls[0] as unknown[];
      expect(call[1]).toBe('Premium importé');
      expect(call[2]).toBe('Venu d’un autre environnement');
    });

    it('n’importe PAS la version source — la base réattribue la sienne', async () => {
      await t.service.import('start', payload, undefined, CTX);
      const call = t.repo.create.mock.calls[0] as unknown[];
      expect(call).not.toContain(12);
    });

    it('respecte un verrouillage optimiste quand une version est attendue', async () => {
      t.repo.currentVersion.mockResolvedValue(4);
      await t.service.import('start', payload, 4, CTX);
      expect((t.repo.updateWithVersion.mock.calls[0] as unknown[])[5]).toBe(4);
    });

    it('journalise l’import avec la gamme d’origine', async () => {
      await t.service.import('start', payload, undefined, CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'profile.imported',
          details: { gamme: 'start', sourceProfile: 'premium' },
        }),
      );
    });
  });

  describe('ensureDefaultProfile', () => {
    it('crée le repli quand il manque', async () => {
      t.repo.currentVersion.mockResolvedValue(null);
      await t.service.ensureDefaultProfile();
      expect(t.repo.create).toHaveBeenCalledWith(
        DEFAULT_PROFILE,
        'Profil par défaut',
        expect.any(String),
        expect.anything(),
        'system',
      );
    });

    it('ne touche à rien quand le repli existe déjà', async () => {
      t.repo.currentVersion.mockResolvedValue(1);
      await t.service.ensureDefaultProfile();
      expect(t.repo.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('projette les métadonnées sans les réglages', async () => {
      t.repo.list.mockResolvedValue([
        {
          gamme: 'default',
          label: 'Défaut',
          description: null,
          version: 1,
          created_at: 'c',
          updated_at: 'u',
          updated_by: null,
        },
      ]);
      const list = await t.service.list();
      expect(list[0]).toEqual({
        profile: 'default',
        label: 'Défaut',
        description: null,
        version: 1,
        createdAt: 'c',
        updatedAt: 'u',
        updatedBy: null,
      });
      expect(list[0]).not.toHaveProperty('settings');
    });
  });
});
