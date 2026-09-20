import type { FastifyReply } from 'fastify';
import { PROFILE_EXPORT_VERSION, defaultAnalysisSettings } from '@websentry/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { ProfilesController } from './profiles.controller.js';
import type { ProfilesService } from './profiles.service.js';

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: 50, version: 0 };

function req(over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { ip: '203.0.113.10', headers: {}, cookies: {}, ...over } as AuthenticatedRequest;
}

function build() {
  const headers: Record<string, string> = {};
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
      return reply;
    },
  } as unknown as FastifyReply;

  const profiles = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ profile: 'premium' }),
    save: vi.fn().mockResolvedValue({ profile: 'premium' }),
    remove: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue({ profile: 'premium' }),
    export: vi.fn().mockResolvedValue({
      formatVersion: PROFILE_EXPORT_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      profile: 'premium',
      label: 'Premium',
      description: null,
      sourceVersion: 1,
      settings: defaultAnalysisSettings(),
    }),
    import: vi.fn().mockResolvedValue({ profile: 'start' }),
  };

  return {
    controller: new ProfilesController(profiles as unknown as ProfilesService),
    profiles,
    reply,
    headers,
  };
}

describe('ProfilesController', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('délègue la liste au service', async () => {
    await t.controller.list();
    expect(t.profiles.list).toHaveBeenCalled();
  });

  it('délègue la lecture au service', async () => {
    await t.controller.get('PREMIUM');
    expect(t.profiles.get).toHaveBeenCalledWith('PREMIUM');
  });

  describe('contexte d’écriture', () => {
    it('transmet l’acteur et son IP', async () => {
      await t.controller.save('premium', { settings: defaultAnalysisSettings() }, req(), USER);
      expect(t.profiles.save).toHaveBeenCalledWith('premium', expect.anything(), {
        actorId: 'u1',
        actorName: 'alice',
        ipAddress: '203.0.113.10',
      });
    });

    it('tolère une requête sans IP', async () => {
      await t.controller.remove('premium', req({ ip: undefined }), USER);
      expect(t.profiles.remove).toHaveBeenCalledWith(
        'premium',
        expect.objectContaining({ ipAddress: null }),
      );
    });
  });

  describe('export', () => {
    it('propose le fichier en téléchargement, nommé d’après la gamme NORMALISÉE', async () => {
      // Le nom vient de la valeur rendue par le service, jamais de l'entrée
      // brute : un en-tête est un vecteur d'injection s'il n'est pas borné.
      await t.controller.exportProfile('PREMIUM Plus!', t.reply);
      expect(t.headers['Content-Disposition']).toBe(
        'attachment; filename="websentry-profil-premium.json"',
      );
    });

    it('rend l’enveloppe complète', async () => {
      const payload = await t.controller.exportProfile('premium', t.reply);
      expect(payload).toMatchObject({ formatVersion: PROFILE_EXPORT_VERSION, profile: 'premium' });
    });
  });

  describe('import', () => {
    it('transmet la gamme de DESTINATION et la version attendue', async () => {
      const payload = {
        formatVersion: PROFILE_EXPORT_VERSION as 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        profile: 'premium',
        label: 'Premium',
        description: null,
        sourceVersion: 1,
        settings: defaultAnalysisSettings(),
      };

      await t.controller.importProfile('start', { payload, expectedVersion: 2 }, req(), USER);
      expect(t.profiles.import).toHaveBeenCalledWith(
        'start',
        payload,
        2,
        expect.objectContaining({ actorName: 'alice' }),
      );
    });
  });

  it('délègue la réinitialisation', async () => {
    await t.controller.reset('premium', req(), USER);
    expect(t.profiles.reset).toHaveBeenCalledWith('premium', expect.anything());
  });

  it('délègue la suppression', async () => {
    await t.controller.remove('premium', req(), USER);
    expect(t.profiles.remove).toHaveBeenCalledWith('premium', expect.anything());
  });
});
