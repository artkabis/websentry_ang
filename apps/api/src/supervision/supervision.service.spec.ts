import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisRunnerService } from '../analysis/analysis-runner.service.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { SupervisionRepository } from '../database/repositories/supervision.repository.js';
import type { ScanRetentionService } from '../scans/scan-retention.service.js';
import { SupervisionService } from './supervision.service.js';

interface Surcharges {
  db?: Record<string, unknown>;
  repo?: Record<string, unknown>;
  runner?: Record<string, unknown>;
  retention?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

function setup(over: Surcharges = {}) {
  const db = {
    ping: vi.fn().mockResolvedValue({ ok: true, latenceMs: 3, erreur: null }),
    ...over.db,
  } as unknown as DatabaseService;

  const repo = {
    available: true,
    scans24h: vi.fn().mockResolvedValue(12),
    scans7j: vi.fn().mockResolvedValue(80),
    comptesActifs: vi.fn().mockResolvedValue(5),
    retoursOuverts: vi.fn().mockResolvedValue(2),
    ...over.repo,
  } as unknown as SupervisionRepository;

  const runner = {
    etat: vi.fn().mockReturnValue({ active: true, demarre: true, enEchec: false, threadsMax: 4 }),
    ...over.runner,
  } as unknown as AnalysisRunnerService;

  const retention = {
    dernierPassage: vi.fn().mockReturnValue(null),
    ...over.retention,
  } as unknown as ScanRetentionService;

  const config = {
    nodeEnv: 'production',
    retention: { enabled: true },
    ...over.config,
  } as unknown as AppConfigService;

  return {
    db,
    repo,
    runner,
    retention,
    service: new SupervisionService(db, repo, runner, retention, config),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('relevé global', () => {
  it('rend « ok » quand tout va bien', async () => {
    const releve = await t.service.releve();
    expect(releve.etat).toBe('ok');
    expect(releve.instance).toMatchObject({ version: '2.0.0', environnement: 'production' });
    expect(releve.instance.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('DÉRIVE le verdict des composants, sans le déclarer à part', async () => {
    // Deux sources pourraient se contredire, et c'est alors le résumé qu'on
    // croit.
    const casse = setup({
      runner: {
        etat: vi.fn().mockReturnValue({
          active: true,
          demarre: false,
          enEchec: true,
          threadsMax: 4,
        }),
      },
    });

    const releve = await casse.service.releve();
    expect(releve.poolAnalyse.etat).toBe('degrade');
    expect(releve.etat).toBe('degrade');
  });

  it('retient LE PIRE état, pas la majorité', async () => {
    const enPanne = setup({
      db: {
        ping: vi.fn().mockResolvedValue({ ok: false, latenceMs: null, erreur: 'ECONNREFUSED' }),
      },
    });

    const releve = await enPanne.service.releve();
    expect(releve.base.etat).toBe('panne');
    expect(releve.poolAnalyse.etat).toBe('ok');
    expect(releve.etat).toBe('panne');
  });

  it('bascule le verdict sur la SEULE rétention, base et pool sains', async () => {
    // Chaque composant doit peser sur le verdict pris isolément : en tester
    // trois « à tour de rôle » laisse passer un composant oublié dans le
    // calcul global.
    const enEchec = setup({
      retention: {
        dernierPassage: vi.fn().mockReturnValue({
          termineA: '2026-01-01T03:00:00.000Z',
          compresses: 0,
          purges: 0,
          restants: 0,
          dureeMs: 120,
          reussi: false,
        }),
      },
    });

    const releve = await enEchec.service.releve();
    expect(releve.base.etat).toBe('ok');
    expect(releve.poolAnalyse.etat).toBe('ok');
    expect(releve.retention.etat).toBe('panne');
    expect(releve.etat).toBe('panne');
  });

  it('bascule le verdict sur la SEULE base, pool et rétention sains', async () => {
    const sansBase = setup({
      db: { ping: vi.fn().mockResolvedValue({ ok: false, latenceMs: null, erreur: null }) },
    });

    const releve = await sansBase.service.releve();
    expect(releve.poolAnalyse.etat).toBe('ok');
    expect(releve.retention.etat).toBe('ok');
    expect(releve.etat).toBe('degrade');
  });

  it('horodate le relevé', async () => {
    expect(Date.parse((await t.service.releve()).releveA)).not.toBeNaN();
  });
});

describe('base de données', () => {
  it('annonce la latence mesurée', async () => {
    const releve = await t.service.releve();
    expect(releve.base).toMatchObject({ etat: 'ok', active: true, latenceMs: 3 });
    expect(releve.base.message).toContain('3 ms');
  });

  it('DISTINGUE une base désactivée d’une base en panne', async () => {
    // Un choix de configuration n'est pas un incident : l'annoncer comme une
    // panne ferait chercher un problème là où il n'y en a pas.
    const sansBase = setup({
      db: { ping: vi.fn().mockResolvedValue({ ok: false, latenceMs: null, erreur: null }) },
    });

    const releve = await sansBase.service.releve();
    expect(releve.base).toMatchObject({ etat: 'degrade', active: false });
    expect(releve.base.message).toContain('DB_ENABLED=false');
  });

  it('N’EXPOSE PAS le message d’erreur du pilote', async () => {
    // « ECONNREFUSED 10.0.3.14:3306 » renseignerait sur la topologie interne.
    const enPanne = setup({
      db: {
        ping: vi
          .fn()
          .mockResolvedValue({ ok: false, latenceMs: null, erreur: 'ECONNREFUSED 10.0.3.14:3306' }),
      },
    });

    const releve = await enPanne.service.releve();
    expect(JSON.stringify(releve)).not.toContain('10.0.3.14');
    expect(JSON.stringify(releve)).not.toContain('ECONNREFUSED');
  });
});

describe('pool d’analyse', () => {
  it('annonce « ok » quand les threads sont désactivés par configuration', async () => {
    // Ce n'est pas une panne : l'analyse en ligne est un mode de
    // fonctionnement prévu.
    const enLigne = setup({
      runner: {
        etat: vi.fn().mockReturnValue({
          active: false,
          demarre: false,
          enEchec: false,
          threadsMax: 0,
        }),
      },
    });

    const releve = await enLigne.service.releve();
    expect(releve.poolAnalyse.etat).toBe('ok');
    expect(releve.poolAnalyse.message).toContain('désactivés');
  });

  it('annonce DÉGRADÉ, et non en panne, quand le pool a échoué', async () => {
    // L'outil rend toujours un rapport, seulement plus lentement. Le ranger
    // en panne ferait réagir dans l'urgence pour une perte de débit.
    const tombe = setup({
      runner: {
        etat: vi.fn().mockReturnValue({
          active: true,
          demarre: false,
          enEchec: true,
          threadsMax: 4,
        }),
      },
    });

    const releve = await tombe.service.releve();
    expect(releve.poolAnalyse.etat).toBe('degrade');
    expect(releve.poolAnalyse.message).toContain('plus lentes');
  });

  it('distingue un pool PRÊT d’un pool démarré', async () => {
    // Le pool est paresseux : « non démarré » est normal sur une instance qui
    // ne sert que des lectures.
    const pret = setup({
      runner: {
        etat: vi.fn().mockReturnValue({
          active: true,
          demarre: false,
          enEchec: false,
          threadsMax: 4,
        }),
      },
    });

    const releve = await pret.service.releve();
    expect(releve.poolAnalyse.etat).toBe('ok');
    expect(releve.poolAnalyse.message).toContain('première analyse');
  });

  it('n’a AUCUN effet de bord — interroger n’est pas démarrer', async () => {
    await t.service.releve();
    expect(t.runner.etat).toHaveBeenCalledTimes(1);
  });
});

describe('rétention', () => {
  it('annonce DÉGRADÉ quand elle est désactivée', async () => {
    // Les rapports s'accumulent : ce n'est pas un incident, mais ce n'est pas
    // non plus un fonctionnement sain à laisser sans le dire.
    const eteinte = setup({ config: { nodeEnv: 'production', retention: { enabled: false } } });

    const releve = await eteinte.service.releve();
    expect(releve.retention).toMatchObject({ etat: 'degrade', active: false });
  });

  it('distingue « aucun passage » d’un passage sans travail', async () => {
    const releve = await t.service.releve();
    expect(releve.retention.etat).toBe('ok');
    expect(releve.retention.message).toContain('Aucun passage');
    expect(releve.retention.dernierPassage).toBeNull();
  });

  it('annonce EN PANNE après un passage en échec', async () => {
    const echoue = setup({
      retention: {
        dernierPassage: vi.fn().mockReturnValue({
          termineA: '2026-01-01T03:00:00.000Z',
          compresses: 0,
          purges: 0,
          restants: 0,
          dureeMs: 120,
          reussi: false,
        }),
      },
    });

    const releve = await echoue.service.releve();
    expect(releve.retention.etat).toBe('panne');
    expect(releve.retention.message).toContain('la file grandit');
  });

  it('annonce DÉGRADÉ quand la file ne se vide pas', async () => {
    // Le symptôme silencieux de la v1 : invisible jusqu'au disque plein.
    const enRetard = setup({
      retention: {
        dernierPassage: vi.fn().mockReturnValue({
          termineA: '2026-01-01T03:00:00.000Z',
          compresses: 500,
          purges: 100,
          restants: 4200,
          dureeMs: 9000,
          reussi: true,
        }),
      },
    });

    const releve = await enRetard.service.releve();
    expect(releve.retention.etat).toBe('degrade');
    expect(releve.retention.message).toContain('4200');
  });

  it('annonce « ok » quand le passage a tout absorbé', async () => {
    const propre = setup({
      retention: {
        dernierPassage: vi.fn().mockReturnValue({
          termineA: '2026-01-01T03:00:00.000Z',
          compresses: 12,
          purges: 3,
          restants: 0,
          dureeMs: 800,
          reussi: true,
        }),
      },
    });

    const releve = await propre.service.releve();
    expect(releve.retention.etat).toBe('ok');
    expect(releve.retention.dernierPassage?.compresses).toBe(12);
  });
});

describe('volumétrie', () => {
  it('rend les quatre comptages', async () => {
    expect((await t.service.releve()).volumetrie).toEqual({
      scans24h: 12,
      scans7j: 80,
      comptesActifs: 5,
      retoursOuverts: 2,
    });
  });

  it('n’INVENTE RIEN quand la base est en panne', async () => {
    // Des zéros passeraient pour une instance au repos.
    const enPanne = setup({
      db: { ping: vi.fn().mockResolvedValue({ ok: false, latenceMs: null, erreur: 'refus' }) },
    });

    const releve = await enPanne.service.releve();
    expect(releve.volumetrie).toBeNull();
    expect(enPanne.repo.scans24h).not.toHaveBeenCalled();
  });

  it('rend null quand le dépôt est indisponible', async () => {
    const sansDepot = setup({ repo: { available: false } });
    expect((await sansDepot.service.releve()).volumetrie).toBeNull();
  });

  it('AVALE son échec sans emporter le relevé', async () => {
    // La volumétrie est un agrément, pas un diagnostic : la perdre ne doit
    // pas priver de la vue sur les composants.
    const casse = setup({
      repo: { scans7j: vi.fn().mockRejectedValue(new Error('table absente')) },
    });

    const releve = await casse.service.releve();
    expect(releve.volumetrie).toBeNull();
    expect(releve.etat).toBe('ok');
    expect(releve.base.etat).toBe('ok');
  });
});
