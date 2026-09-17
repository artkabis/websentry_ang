import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as mysql from 'mysql2/promise';
import type { AppConfigService } from '../config/app-config.service.js';
import { DatabaseService } from './database.service.js';

vi.mock('mysql2/promise', () => ({ createPool: vi.fn() }));

const createPool = vi.mocked(mysql.createPool);

function configStub(dbEnabled = true): AppConfigService {
  return {
    dbEnabled,
    database: {
      host: 'localhost',
      port: 3306,
      database: 'websentry',
      user: 'websentry',
      password: 'motdepasse',
      connectionLimit: 10,
    },
  } as AppConfigService;
}

function poolStub() {
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    execute: vi.fn().mockResolvedValue([{}]),
  };
  const pool = {
    getConnection: vi.fn().mockResolvedValue(connection),
    query: vi.fn().mockResolvedValue([[], []]),
    execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { pool, connection };
}

describe('DatabaseService', () => {
  let stub: ReturnType<typeof poolStub>;

  beforeEach(() => {
    stub = poolStub();
    createPool.mockReturnValue(stub.pool as never);
  });

  describe('onModuleInit', () => {
    it('ne crée aucun pool quand DB_ENABLED vaut false', async () => {
      const service = new DatabaseService(configStub(false));
      await service.onModuleInit();
      expect(createPool).not.toHaveBeenCalled();
      expect(service.enabled).toBe(false);
    });

    it('désactive multipleStatements — une injection ne doit pas devenir une chaîne de commandes', async () => {
      const service = new DatabaseService(configStub());
      await service.onModuleInit();
      expect(createPool).toHaveBeenCalledWith(
        expect.objectContaining({ multipleStatements: false }),
      );
    });

    it('vérifie la connexion au démarrage, puis rend la connexion au pool', async () => {
      const service = new DatabaseService(configStub());
      await service.onModuleInit();
      expect(stub.pool.getConnection).toHaveBeenCalled();
      expect(stub.connection.release).toHaveBeenCalled();
      expect(service.enabled).toBe(true);
    });

    it('fait ÉCHOUER le démarrage si la base est injoignable', async () => {
      // Mieux vaut ne pas démarrer que servir avec une base absente.
      stub.pool.getConnection.mockRejectedValue(new Error('ECONNREFUSED'));
      const service = new DatabaseService(configStub());
      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('sans pool', () => {
    it('lève sur toute requête quand la base est désactivée', async () => {
      const service = new DatabaseService(configStub(false));
      await service.onModuleInit();
      await expect(service.query('SELECT 1')).rejects.toThrow(/non disponible/);
      await expect(service.execute('SELECT 1')).rejects.toThrow(/non disponible/);
      await expect(service.transaction(async () => 1)).rejects.toThrow(/non disponible/);
    });
  });

  describe('requêtes', () => {
    let service: DatabaseService;

    beforeEach(async () => {
      service = new DatabaseService(configStub());
      await service.onModuleInit();
    });

    it('sépare toujours le SQL de ses valeurs', async () => {
      await service.query('SELECT * FROM users WHERE id = ?', ['u1']);
      expect(stub.pool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', ['u1']);
    });

    it('accepte une requête sans paramètre', async () => {
      await service.query('SELECT 1');
      expect(stub.pool.query).toHaveBeenCalledWith('SELECT 1', []);
    });

    it('queryOne retourne la première ligne', async () => {
      stub.pool.query.mockResolvedValue([[{ id: 'u1' }, { id: 'u2' }], []]);
      await expect(service.queryOne('SELECT 1')).resolves.toEqual({ id: 'u1' });
    });

    it('queryOne retourne null sur résultat vide', async () => {
      stub.pool.query.mockResolvedValue([[], []]);
      await expect(service.queryOne('SELECT 1')).resolves.toBeNull();
    });

    it('execute retourne le nombre de lignes touchées', async () => {
      stub.pool.query.mockResolvedValue([{ affectedRows: 3 }, []]);
      await expect(service.execute('DELETE FROM x')).resolves.toBe(3);
    });

    it('execute retourne 0 quand le driver ne renvoie pas affectedRows', async () => {
      stub.pool.query.mockResolvedValue([{}, []]);
      await expect(service.execute('DELETE FROM x')).resolves.toBe(0);
    });
  });

  describe('transaction', () => {
    let service: DatabaseService;

    beforeEach(async () => {
      service = new DatabaseService(configStub());
      await service.onModuleInit();
    });

    it('valide la transaction au succès', async () => {
      await expect(service.transaction(async () => 'ok')).resolves.toBe('ok');
      expect(stub.connection.beginTransaction).toHaveBeenCalled();
      expect(stub.connection.commit).toHaveBeenCalled();
      expect(stub.connection.rollback).not.toHaveBeenCalled();
    });

    it('annule la transaction et propage l’erreur', async () => {
      await expect(
        service.transaction(async () => {
          throw new Error('échec métier');
        }),
      ).rejects.toThrow('échec métier');
      expect(stub.connection.rollback).toHaveBeenCalled();
      expect(stub.connection.commit).not.toHaveBeenCalled();
    });

    it('rend TOUJOURS la connexion au pool, succès ou échec', async () => {
      await service.transaction(async () => 1);
      await service.transaction(async () => {
        throw new Error('x');
      }).catch(() => undefined);
      expect(stub.connection.release).toHaveBeenCalledTimes(3); // 1 au boot + 2 transactions
    });

    it('rend la connexion même si le rollback échoue lui aussi', async () => {
      stub.connection.rollback.mockRejectedValue(new Error('connexion perdue'));
      await expect(
        service.transaction(async () => {
          throw new Error('échec métier');
        }),
      ).rejects.toThrow('échec métier');
      expect(stub.connection.release).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('ferme le pool', async () => {
      const service = new DatabaseService(configStub());
      await service.onModuleInit();
      await service.onModuleDestroy();
      expect(stub.pool.end).toHaveBeenCalled();
      expect(service.enabled).toBe(false);
    });

    it('reste inoffensif quand aucun pool n’a été créé', async () => {
      const service = new DatabaseService(configStub(false));
      await service.onModuleInit();
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
