import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { UsageRepository } from '../database/repositories/usage.repository.js';
import { AuditAnonymizationService } from './audit-anonymization.service.js';

function build(
  opts: {
    enabled?: boolean;
    afterDays?: number;
    batchSize?: number;
    available?: boolean;
    anonymiser?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const anonymiser = opts.anonymiser ?? vi.fn().mockResolvedValue(0);
  const repo = { available: opts.available ?? true, anonymiser };
  const config = {
    anonymisation: {
      enabled: opts.enabled ?? true,
      afterDays: opts.afterDays ?? 180,
      batchSize: opts.batchSize ?? 1000,
    },
  };

  return {
    anonymiser,
    service: new AuditAnonymizationService(
      repo as unknown as UsageRepository,
      config as unknown as AppConfigService,
    ),
  };
}

describe('AuditAnonymizationService', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('seuil de conservation', () => {
    it('recule du nombre de jours configuré', () => {
      const t = build({ afterDays: 30 });
      const seuil = t.service.seuil(new Date('2026-03-31T12:00:00.000Z'));

      expect(seuil.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    });

    it('franchit correctement un changement de mois et d’année', () => {
      const t = build({ afterDays: 180 });
      const seuil = t.service.seuil(new Date('2026-01-15T00:00:00.000Z'));

      expect(seuil.toISOString().slice(0, 10)).toBe('2025-07-19');
    });
  });

  describe('exécution', () => {
    it('anonymise par LOTS jusqu’à épuisement', async () => {
      // Une seule requête sur un journal volumineux bloquerait la table
      // pendant tout le passage, et l'API avec elle.
      const anonymiser = vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(37);
      const t = build({ batchSize: 100, anonymiser });

      await expect(t.service.run()).resolves.toBe(237);
      expect(anonymiser).toHaveBeenCalledTimes(3);
    });

    it('s’arrête dès qu’un lot ne remplit plus la borne', async () => {
      const anonymiser = vi.fn().mockResolvedValue(0);
      const t = build({ batchSize: 100, anonymiser });

      await expect(t.service.run()).resolves.toBe(0);
      expect(anonymiser).toHaveBeenCalledTimes(1);
    });

    it('ne fait RIEN quand la politique est désactivée', async () => {
      const t = build({ enabled: false });

      await expect(t.service.run()).resolves.toBe(0);
      expect(t.anonymiser).not.toHaveBeenCalled();
    });

    it('ne fait RIEN sans base de données', async () => {
      const t = build({ available: false });

      await expect(t.service.run()).resolves.toBe(0);
      expect(t.anonymiser).not.toHaveBeenCalled();
    });

    it('REFUSE deux passages simultanés', async () => {
      // Le travail est déclenché au démarrage PUIS à intervalle : un passage
      // peut déborder sur l'heure du suivant.
      let resoudre: (v: number) => void = () => undefined;
      const anonymiser = vi.fn().mockImplementation(
        () =>
          new Promise<number>(r => {
            resoudre = r;
          }),
      );
      const t = build({ anonymiser });

      const premier = t.service.run();
      await expect(t.service.run()).resolves.toBe(0);

      resoudre(0);
      await premier;
      expect(anonymiser).toHaveBeenCalledTimes(1);
    });

    it('LIBÈRE le garde après un passage', async () => {
      const t = build();
      await t.service.run();
      await t.service.run();

      expect(t.anonymiser).toHaveBeenCalledTimes(2);
    });
  });

  describe('trace du dernier passage', () => {
    it('n’annonce AUCUN passage avant le premier', () => {
      // « Aucun passage depuis le démarrage » vaut mieux que de laisser croire
      // à une absence de travail.
      expect(build().service.dernierPassage()).toBeNull();
    });

    it('retient ce qu’un passage réussi a fait', async () => {
      const anonymiser = vi.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(0);
      const t = build({ batchSize: 100, anonymiser });

      await t.service.run();
      const passage = t.service.dernierPassage();

      expect(passage?.anonymisees).toBe(12);
      expect(passage?.reussi).toBe(true);
      expect(passage?.termineA).toMatch(/^\d{4}-/);
    });

    it('RETIENT l’échec avant de le propager', async () => {
      // La gouvernance doit pouvoir dire qu'un passage a échoué, pas seulement
      // qu'il n'a rien fait.
      const anonymiser = vi.fn().mockRejectedValue(new Error('table verrouillée'));
      const t = build({ anonymiser });

      await expect(t.service.run()).rejects.toThrow('table verrouillée');
      expect(t.service.dernierPassage()?.reussi).toBe(false);
    });

    it('LIBÈRE le garde même après un échec', async () => {
      const anonymiser = vi
        .fn()
        .mockRejectedValueOnce(new Error('verrou'))
        .mockResolvedValueOnce(0);
      const t = build({ anonymiser });

      await expect(t.service.run()).rejects.toThrow();
      await expect(t.service.run()).resolves.toBe(0);
    });
  });
});
