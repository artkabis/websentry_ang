import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service.js';
import type { UsageRepository } from '../database/repositories/usage.repository.js';
import type { AuditAnonymizationService } from './audit-anonymization.service.js';
import { UsageService } from './usage.service.js';

const MAINTENANT = new Date('2026-03-31T12:00:00.000Z');

function build(
  opts: {
    available?: boolean;
    comptesActifs?: number;
    compteurAudit?: ReturnType<typeof vi.fn>;
    compteurAnalyses?: unknown;
    connexionsParJour?: unknown[];
    analysesParJour?: unknown[];
    gammes?: unknown[];
    anonymisees?: number;
    enAttente?: number;
    dernierPassage?: { termineA: string } | null;
  } = {},
) {
  const repo = {
    available: opts.available ?? true,
    comptesActifs: vi.fn().mockResolvedValue(opts.comptesActifs ?? 7),
    compteurAudit: opts.compteurAudit ?? vi.fn().mockResolvedValue({ comptes: 6, actions: 40 }),
    // `??` trancherait mal ici : un test passe DÉLIBÉRÉMENT `null` pour
    // simuler une base neuve, et le repli l'écraserait avec une valeur.
    compteurAnalyses: vi
      .fn()
      .mockResolvedValue(
        'compteurAnalyses' in opts ? opts.compteurAnalyses : { comptes: 4, actions: 120 },
      ),
    connexionsParJour: vi.fn().mockResolvedValue(opts.connexionsParJour ?? []),
    analysesParJour: vi.fn().mockResolvedValue(opts.analysesParJour ?? []),
    gammes: vi.fn().mockResolvedValue(opts.gammes ?? []),
    lignesAnonymisees: vi.fn().mockResolvedValue(opts.anonymisees ?? 0),
    lignesEnAttente: vi.fn().mockResolvedValue(opts.enAttente ?? 0),
  };
  const anonymisation = {
    seuil: vi.fn().mockReturnValue(new Date('2025-10-02T12:00:00.000Z')),
    dernierPassage: vi.fn().mockReturnValue(opts.dernierPassage ?? null),
  };
  const config = {
    anonymisation: { enabled: true, afterDays: 180, batchSize: 1000 },
    retention: { purgeAfterDays: 365 },
  };

  return {
    repo,
    anonymisation,
    service: new UsageService(
      repo as unknown as UsageRepository,
      anonymisation as unknown as AuditAnonymizationService,
      config as unknown as AppConfigService,
    ),
  };
}

describe('UsageService', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('sans base de données', () => {
    it.each([
      ['overview', (s: UsageService) => s.overview('30j')],
      ['governance', (s: UsageService) => s.governance()],
    ])('REFUSE %s plutôt que de rendre des zéros', async (_nom, appel) => {
      // Des compteurs à zéro et une base absente ne se confondent pas : les
      // premiers se lisent « personne n'a rien fait ».
      await expect(appel(build({ available: false }).service)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('fenêtre d’observation', () => {
    it('recule du nombre de jours de la période', async () => {
      const t = build();
      const vue = await t.service.overview('7j', MAINTENANT);

      expect(vue.depuis).toBe('2026-03-24T12:00:00.000Z');
      expect(vue.jusqua).toBe('2026-03-31T12:00:00.000Z');
    });

    it('interroge la base avec la MÊME borne partout', async () => {
      // Deux bornes divergentes produiraient un tunnel dont les étages ne
      // parlent pas de la même période.
      const t = build();
      await t.service.overview('30j', MAINTENANT);

      const bornes = new Set([
        t.repo.comptesActifs.mock.calls[0]?.[0],
        t.repo.compteurAnalyses.mock.calls[0]?.[0],
        t.repo.connexionsParJour.mock.calls[0]?.[0],
        t.repo.analysesParJour.mock.calls[0]?.[0],
        t.repo.gammes.mock.calls[0]?.[0],
      ]);
      expect(bornes.size).toBe(1);
    });

    it('passe à SQL un horodatage sans « T » ni millisecondes', async () => {
      const t = build();
      await t.service.overview('30j', MAINTENANT);

      expect(t.repo.comptesActifs.mock.calls[0]?.[0]).toBe('2026-03-01 12:00:00');
    });
  });

  describe('tunnel', () => {
    it('rend les TROIS étapes, dans l’ordre', async () => {
      const t = build();
      const vue = await t.service.overview('30j', MAINTENANT);

      expect(vue.tunnel.map(e => e.cle)).toEqual(['connexion', 'analyse', 'exploitation']);
    });

    it('tire l’étape « analyse » de l’HISTORIQUE, pas du journal', async () => {
      // Lancer une analyse ne laisse pas de trace au journal : l'historique
      // est déjà cette trace, et mieux renseignée. L'écrire deux fois
      // produirait deux compteurs qui divergent.
      const t = build({ compteurAnalyses: { comptes: 4, actions: 120 } });
      const vue = await t.service.overview('30j', MAINTENANT);

      expect(t.repo.compteurAnalyses).toHaveBeenCalled();
      expect(vue.tunnel[1]).toEqual({ cle: 'analyse', comptes: 4, actions: 120 });
    });

    it('distingue CONNEXION et EXPLOITATION par leurs actions', async () => {
      const t = build();
      await t.service.overview('30j', MAINTENANT);

      const connexion = t.repo.compteurAudit.mock.calls[0]?.[0] as string[];
      const exploitation = t.repo.compteurAudit.mock.calls[1]?.[0] as string[];

      expect(connexion).toEqual(['auth.login']);
      expect(exploitation).toContain('profile.updated');
      expect(exploitation).toContain('feedback.create');
      // Consulter n'est pas exploiter, et la lecture n'est pas journalisée :
      // l'ajouter au journal pour nourrir un compteur reviendrait à collecter
      // pour mesurer.
      expect(exploitation).not.toContain('auth.login');
    });

    it('rend ZÉRO plutôt que « null » sur une base neuve', async () => {
      const t = build({ compteurAudit: vi.fn().mockResolvedValue(null), compteurAnalyses: null });
      const vue = await t.service.overview('30j', MAINTENANT);

      expect(vue.tunnel.every(e => e.comptes === 0 && e.actions === 0)).toBe(true);
    });
  });

  describe('série quotidienne', () => {
    it('est CONTINUE — les jours vides valent zéro', async () => {
      // Une courbe qui saute les jours sans activité ment sur sa pente : deux
      // points espacés d'une semaine y paraissent consécutifs.
      const t = build({
        connexionsParJour: [{ jour: '2026-03-25', total: 3 }],
        analysesParJour: [{ jour: '2026-03-27', total: 9 }],
      });
      const vue = await t.service.overview('7j', MAINTENANT);

      expect(vue.parJour).toHaveLength(8);
      expect(vue.parJour[0]).toEqual({ jour: '2026-03-24', connexions: 0, analyses: 0 });
      expect(vue.parJour[1]).toEqual({ jour: '2026-03-25', connexions: 3, analyses: 0 });
      expect(vue.parJour[3]).toEqual({ jour: '2026-03-27', connexions: 0, analyses: 9 });
    });

    it('accepte un jour rendu comme DATE par le pilote', async () => {
      const t = build({
        connexionsParJour: [{ jour: new Date('2026-03-25T00:00:00Z'), total: 2 }],
      });
      const vue = await t.service.overview('7j', MAINTENANT);

      expect(vue.parJour.find(j => j.jour === '2026-03-25')?.connexions).toBe(2);
    });

    it('IGNORE un jour hors de la fenêtre', async () => {
      const t = build({ connexionsParJour: [{ jour: '2020-01-01', total: 99 }] });
      const vue = await t.service.overview('7j', MAINTENANT);

      expect(vue.parJour.some(j => j.connexions > 0)).toBe(false);
    });
  });

  describe('gammes', () => {
    it('convertit les nombres du pilote, et garde NULL comme NULL', async () => {
      // Aucune page notée n'est pas la même chose qu'un score de zéro.
      const t = build({
        gammes: [
          { gamme: 'premium', analyses: '80', score_moyen: '72.5' },
          { gamme: 'standard', analyses: '3', score_moyen: null },
        ],
      });
      const vue = await t.service.overview('30j', MAINTENANT);

      expect(vue.gammes[0]).toEqual({ gamme: 'premium', analyses: 80, scoreMoyen: 72.5 });
      expect(vue.gammes[1]?.scoreMoyen).toBeNull();
    });
  });

  describe('gouvernance', () => {
    it('ANNONCE qu’aucune collecte dédiée n’existe', async () => {
      const t = build();
      expect((await t.service.governance(MAINTENANT)).collecteDediee).toBe(false);
    });

    it('DÉCRIT les tables réellement lues, avec leur finalité', async () => {
      const t = build();
      const registre = await t.service.governance(MAINTENANT);

      expect(registre.sources.map(s => s.table)).toEqual([
        'audit_log',
        'scan_sessions',
        'scan_trash',
        'users',
      ]);
      expect(registre.sources.every(s => s.finalite.length > 0)).toBe(true);
      expect(registre.sources[0]?.donnees).toContain('adresse IP');
    });

    it('dit qu’un compte n’est PAS purgé automatiquement', async () => {
      // Le taire laisserait croire à une purge qui n'existe pas.
      const t = build();
      const users = (await t.service.governance(MAINTENANT)).sources.find(s => s.table === 'users');

      expect(users?.retentionJours).toBeNull();
    });

    it('fait suivre à `scan_sessions` la politique de PURGE des rapports', async () => {
      const t = build();
      const scans = (await t.service.governance(MAINTENANT)).sources.find(
        s => s.table === 'scan_sessions',
      );

      expect(scans?.retentionJours).toBe(365);
    });

    it('COMPTE ce qui reste à anonymiser, au seuil du jour', async () => {
      const t = build({ anonymisees: 1200, enAttente: 37 });
      const registre = await t.service.governance(MAINTENANT);

      expect(t.anonymisation.seuil).toHaveBeenCalledWith(MAINTENANT);
      expect(t.repo.lignesEnAttente).toHaveBeenCalledWith('2025-10-02 12:00:00');
      expect(registre.anonymisation).toMatchObject({ anonymisees: 1200, enAttente: 37 });
    });

    it('annonce l’ABSENCE de passage plutôt qu’une date inventée', async () => {
      const t = build();
      expect((await t.service.governance(MAINTENANT)).anonymisation.dernierPassage).toBeNull();
    });

    it('rapporte la date du dernier passage quand il y en a un', async () => {
      const t = build({ dernierPassage: { termineA: '2026-03-31T03:00:00.000Z' } });
      const registre = await t.service.governance(MAINTENANT);

      expect(registre.anonymisation.dernierPassage).toBe('2026-03-31T03:00:00.000Z');
    });
  });

  describe('ce que le module ne rend JAMAIS', () => {
    it('n’expose AUCUN nom ni identifiant dans l’aperçu', async () => {
      // La question « qui a fait quoi » se lit dans le journal d'audit,
      // réservé au rang 100 ; « combien de comptes font quoi » se lit ici.
      const t = build({
        gammes: [{ gamme: 'premium', analyses: 3, score_moyen: 50 }],
        connexionsParJour: [{ jour: '2026-03-25', total: 3 }],
      });
      const vue = await t.service.overview('30j', MAINTENANT);
      const corps = JSON.stringify(vue);

      expect(corps).not.toContain('actor');
      expect(corps).not.toContain('username');
      expect(corps).not.toContain('launched_by');
      expect(corps).not.toContain('ip');
    });
  });
});
