import { DEFAULT_PROFILE, defaultAnalysisSettings } from '@websentry/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { SettingsController } from './settings.controller.js';

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: 50, version: 0 };
const req = () => ({ ip: '203.0.113.10' }) as AuthenticatedRequest;

function build() {
  const profiles = {
    get: vi.fn().mockResolvedValue({ profile: DEFAULT_PROFILE }),
    save: vi.fn().mockResolvedValue({ profile: DEFAULT_PROFILE }),
    reset: vi.fn().mockResolvedValue({ profile: DEFAULT_PROFILE }),
  };
  return {
    controller: new SettingsController(profiles as unknown as ProfilesService),
    profiles,
  };
}

describe('SettingsController', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('LIT le profil de repli — les réglages globaux n’ont pas de stockage propre', () => {
    // La v1 tenait deux fichiers distincts qui pouvaient diverger en silence.
    void t.controller.get();
    expect(t.profiles.get).toHaveBeenCalledWith(DEFAULT_PROFILE);
  });

  it('ÉCRIT dans le profil de repli', async () => {
    await t.controller.save({ settings: defaultAnalysisSettings() }, req(), USER);
    expect(t.profiles.save).toHaveBeenCalledWith(
      DEFAULT_PROFILE,
      expect.anything(),
      expect.objectContaining({ actorName: 'alice' }),
    );
  });

  it('transmet la version attendue pour le verrouillage optimiste', async () => {
    await t.controller.save(
      { settings: defaultAnalysisSettings(), expectedVersion: 5 },
      req(),
      USER,
    );
    const body = (t.profiles.save.mock.calls[0] as unknown[])[1] as { expectedVersion?: number };
    expect(body.expectedVersion).toBe(5);
  });

  it('réinitialise le profil de repli', async () => {
    await t.controller.reset(req(), USER);
    expect(t.profiles.reset).toHaveBeenCalledWith(DEFAULT_PROFILE, expect.anything());
  });
});
