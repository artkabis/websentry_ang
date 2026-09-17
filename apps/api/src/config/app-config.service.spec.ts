import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AppConfigService } from './app-config.service.js';
import type { Env } from './env.schema.js';

function build(over: Partial<Env> = {}): AppConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'development',
    PORT: 3031,
    HOST: '0.0.0.0',
    CORS_ORIGIN: 'http://localhost:4200',
    JWT_SECRET: 'a'.repeat(32),
    ACCESS_TOKEN_TTL: 900,
    REFRESH_TOKEN_TTL: 604_800,
    LOGIN_MAX_ATTEMPTS: 5,
    LOGIN_LOCKOUT_SECONDS: 900,
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_NAME: 'websentry',
    DB_USER: 'websentry',
    DB_PASSWORD: 'motdepasse',
    DB_CONNECTION_LIMIT: 10,
    DB_ENABLED: true,
    FETCH_USER_AGENT: 'WebSentry/2.0',
    FETCH_TIMEOUT_MS: 15_000,
    LOG_LEVEL: 'info',
    ...over,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
  return new AppConfigService(config);
}

describe('AppConfigService', () => {
  it('expose les valeurs simples', () => {
    const c = build();
    expect(c.nodeEnv).toBe('development');
    expect(c.port).toBe(3031);
    expect(c.host).toBe('0.0.0.0');
    expect(c.jwtSecret).toHaveLength(32);
    expect(c.accessTokenTtl).toBe(900);
    expect(c.refreshTokenTtl).toBe(604_800);
    expect(c.loginMaxAttempts).toBe(5);
    expect(c.loginLockoutSeconds).toBe(900);
    expect(c.dbEnabled).toBe(true);
    expect(c.fetchUserAgent).toBe('WebSentry/2.0');
    expect(c.fetchTimeoutMs).toBe(15_000);
    expect(c.logLevel).toBe('info');
  });

  it('distingue la production des autres environnements', () => {
    expect(build({ NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(build({ NODE_ENV: 'development' }).isProduction).toBe(false);
    expect(build({ NODE_ENV: 'test' }).isProduction).toBe(false);
  });

  describe('corsOrigins', () => {
    it('découpe une liste séparée par des virgules', () => {
      expect(build({ CORS_ORIGIN: 'https://a.fr,https://b.fr' }).corsOrigins).toEqual([
        'https://a.fr',
        'https://b.fr',
      ]);
    });

    it('supprime les espaces et les entrées vides', () => {
      expect(build({ CORS_ORIGIN: ' https://a.fr , , https://b.fr ' }).corsOrigins).toEqual([
        'https://a.fr',
        'https://b.fr',
      ]);
    });

    it('retourne une liste vide pour une valeur vide', () => {
      expect(build({ CORS_ORIGIN: '' }).corsOrigins).toEqual([]);
    });
  });

  describe('database', () => {
    it('regroupe les paramètres de connexion', () => {
      expect(build().database).toEqual({
        host: 'localhost',
        port: 3306,
        database: 'websentry',
        user: 'websentry',
        password: 'motdepasse',
        connectionLimit: 10,
      });
    });
  });

  describe('cookieBase', () => {
    it('impose httpOnly et SameSite=Strict en toutes circonstances', () => {
      const base = build().cookieBase;
      expect(base.httpOnly).toBe(true);
      expect(base.sameSite).toBe('strict');
      expect(base.path).toBe('/');
    });

    it('active Secure en production', () => {
      expect(build({ NODE_ENV: 'production' }).cookieBase.secure).toBe(true);
    });

    it('désactive Secure hors production — sinon le cookie ne reviendrait jamais en HTTP local', () => {
      expect(build({ NODE_ENV: 'development' }).cookieBase.secure).toBe(false);
    });
  });
});
