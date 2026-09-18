import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const SECRET = 'a'.repeat(32);

function env(over: Record<string, string> = {}): Record<string, unknown> {
  return { JWT_SECRET: SECRET, ...over };
}

describe('validateEnv', () => {
  describe('JWT_SECRET', () => {
    it('échoue si le secret est absent — un serveur sans secret ne doit pas démarrer', () => {
      expect(() => validateEnv({})).toThrow(/JWT_SECRET/);
    });

    it('échoue si le secret fait moins de 32 caractères', () => {
      expect(() => validateEnv({ JWT_SECRET: 'trop-court' })).toThrow(/32 caractères/);
    });

    it('accepte un secret de 32 caractères', () => {
      expect(validateEnv(env()).JWT_SECRET).toBe(SECRET);
    });

    it.each(['changeme-changeme-changeme-change', 'test-test-test-test-test-test-abc'])(
      'refuse un secret de démonstration en production (%s)',
      secret => {
        expect(() => validateEnv({ JWT_SECRET: secret, NODE_ENV: 'production' })).toThrow(
          /démonstration/,
        );
      },
    );

    it('tolère ce même secret hors production — pratique en développement', () => {
      expect(() =>
        validateEnv({ JWT_SECRET: 'changeme-changeme-changeme-change', NODE_ENV: 'development' }),
      ).not.toThrow();
    });
  });

  describe('durées de jeton', () => {
    it('refuse un refresh plus court ou égal à l’access — la rotation serait inopérante', () => {
      expect(() => validateEnv(env({ ACCESS_TOKEN_TTL: '900', REFRESH_TOKEN_TTL: '900' }))).toThrow(
        /strictement supérieur/,
      );
    });

    it('accepte un refresh strictement plus long', () => {
      const parsed = validateEnv(env({ ACCESS_TOKEN_TTL: '900', REFRESH_TOKEN_TTL: '3600' }));
      expect(parsed.REFRESH_TOKEN_TTL).toBe(3600);
    });

    it('applique les valeurs par défaut (15 min / 7 jours)', () => {
      const parsed = validateEnv(env());
      expect(parsed.ACCESS_TOKEN_TTL).toBe(900);
      expect(parsed.REFRESH_TOKEN_TTL).toBe(604_800);
    });
  });

  describe('seuils de rétention', () => {
    it('REFUSE une purge antérieure à la compression', () => {
      // Purger avant d'avoir compressé rend la compression inutile : le défaut
      // ne se verrait qu'à la facture de stockage, des mois plus tard.
      expect(() =>
        validateEnv(env({ SCAN_COMPRESS_AFTER_DAYS: '30', SCAN_PURGE_AFTER_DAYS: '7' })),
      ).toThrow(/SCAN_PURGE_AFTER_DAYS/);
    });

    it('refuse deux seuils égaux', () => {
      expect(() =>
        validateEnv(env({ SCAN_COMPRESS_AFTER_DAYS: '30', SCAN_PURGE_AFTER_DAYS: '30' })),
      ).toThrow(/SCAN_PURGE_AFTER_DAYS/);
    });

    it('accepte un ordre cohérent', () => {
      const parsed = validateEnv(
        env({ SCAN_COMPRESS_AFTER_DAYS: '7', SCAN_PURGE_AFTER_DAYS: '365' }),
      );
      expect(parsed.SCAN_PURGE_AFTER_DAYS).toBe(365);
    });

    it('applique les valeurs par défaut', () => {
      const parsed = validateEnv(env());
      expect(parsed.SCAN_COMPRESS_AFTER_DAYS).toBe(7);
      expect(parsed.SCAN_PURGE_AFTER_DAYS).toBe(180);
      expect(parsed.SCAN_RETENTION_BATCH).toBe(500);
      expect(parsed.SCAN_RETENTION_ENABLED).toBe(true);
    });
  });

  describe('coercition et valeurs par défaut', () => {
    it('convertit les entiers reçus sous forme de chaînes', () => {
      const parsed = validateEnv(env({ PORT: '8080', DB_PORT: '3307' }));
      expect(parsed.PORT).toBe(8080);
      expect(parsed.DB_PORT).toBe(3307);
    });

    it('retombe sur la valeur par défaut face à une valeur non numérique', () => {
      expect(validateEnv(env({ PORT: 'pas-un-nombre' })).PORT).toBe(3031);
    });

    it('convertit DB_ENABLED en booléen', () => {
      expect(validateEnv(env({ DB_ENABLED: 'false' })).DB_ENABLED).toBe(false);
      expect(validateEnv(env({ DB_ENABLED: 'true' })).DB_ENABLED).toBe(true);
      expect(validateEnv(env()).DB_ENABLED).toBe(true);
    });

    it('refuse une valeur DB_ENABLED hors des deux littéraux attendus', () => {
      expect(() => validateEnv(env({ DB_ENABLED: 'oui' }))).toThrow(/DB_ENABLED/);
    });

    it('refuse un NODE_ENV inconnu', () => {
      expect(() => validateEnv(env({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV/);
    });

    it('refuse un LOG_LEVEL inconnu', () => {
      expect(() => validateEnv(env({ LOG_LEVEL: 'verbose' }))).toThrow(/LOG_LEVEL/);
    });
  });

  describe('rapport d’erreurs', () => {
    it('énumère TOUTES les variables fautives d’un coup', () => {
      // L'opérateur ne doit pas redémarrer une fois par erreur de configuration.
      const message = (() => {
        try {
          validateEnv({ JWT_SECRET: 'court', NODE_ENV: 'staging', DB_ENABLED: 'oui' });
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      })();

      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('NODE_ENV');
      expect(message).toContain('DB_ENABLED');
    });
  });
});
