import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { API_PREFIX } from '../../src/common/constants.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import type { UserRow } from '../../src/database/repositories/user.repository.js';
import { UserRepository } from '../../src/database/repositories/user.repository.js';
import { SessionRepository } from '../../src/database/repositories/session.repository.js';
import { PermissionRepository } from '../../src/database/repositories/permission.repository.js';
import { AuditRepository } from '../../src/database/repositories/audit.repository.js';

/**
 * Monte l'application COMPLÈTE (adapter Fastify, helmet, cookies, gardes et
 * filtres globaux) sur une base simulée en mémoire.
 *
 * Le choix est délibéré : ce qui est testé ici, ce sont les décisions de sécurité
 * — gardes, cookies, en-têtes, forme des erreurs — et non le dialecte SQL de
 * MariaDB. Simuler la couche de persistance rend la suite déterministe et
 * exécutable partout, y compris en CI sans conteneur. La correction des requêtes
 * SQL, elle, relève des tests d'intégration contre une vraie base (cf. README).
 */

export interface SeedUser {
  id: string;
  username: string;
  password: string;
  rank: number;
  status?: 'active' | 'suspended' | 'pending';
  permissions?: Array<{ permission: string; gammes: string[] | null }>;
}

/** État partagé du double de base, inspectable et modifiable par les tests. */
export class FakeDb {
  readonly users = new Map<string, UserRow>();
  readonly passwords = new Map<string, string>();
  readonly permissions = new Map<string, Array<{ permission: string; gammes: string[] | null }>>();
  readonly sessions = new Map<
    string,
    { id: string; userId: string; expiresAt: Date; revoked: boolean }
  >();
  readonly auditLog: Array<Record<string, unknown>> = [];

  byUsername(username: string): UserRow | null {
    for (const user of this.users.values()) {
      if (user.username === username) return user;
    }
    return null;
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  db: FakeDb;
  /** Résout l'URL complète d'une route, préfixe global compris. */
  url(path: string): string;
  close(): Promise<void>;
}

export const TEST_JWT_SECRET = 'secret-de-test-hs256-suffisamment-long-ok';

/**
 * Hachage de test — SHA-256 salé plutôt que scrypt.
 *
 * scrypt coûte ~100 ms par vérification, ce qui rendrait la suite E2E
 * interminable. Le service réel reste inchangé : seul le double injecté ici
 * raccourcit le calcul.
 */
async function fastHash(password: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `test:${createHash('sha256').update(password).digest('hex')}`;
}

export async function createTestApp(seed: SeedUser[] = []): Promise<TestApp> {
  const db = new FakeDb();

  const userRepo = {
    available: true,
    findByUsername: vi.fn((username: string) => Promise.resolve(db.byUsername(username))),
    findById: vi.fn((id: string) => Promise.resolve(db.users.get(id) ?? null)),
    recordFailedLogin: vi.fn((id: string, failed: number, lockedUntil: Date | null) => {
      const user = db.users.get(id);
      if (user) {
        user.failed_logins = failed;
        user.locked_until = lockedUntil ? lockedUntil.toISOString() : null;
      }
      return Promise.resolve();
    }),
    resetFailedLogins: vi.fn((id: string) => {
      const user = db.users.get(id);
      if (user) {
        user.failed_logins = 0;
        user.locked_until = null;
      }
      return Promise.resolve();
    }),
    bumpTokenVersion: vi.fn((id: string) => {
      const user = db.users.get(id);
      if (user) user.token_version += 1;
      return Promise.resolve();
    }),
  };

  const realSessions = new SessionRepository({} as DatabaseService);
  const sessionRepo = {
    generateRawToken: () => realSessions.generateRawToken(),
    hashToken: (raw: string) => realSessions.hashToken(raw),
    create: vi.fn((userId: string, expiryMs: number) => {
      const raw = realSessions.generateRawToken();
      db.sessions.set(realSessions.hashToken(raw), {
        id: `s-${db.sessions.size + 1}`,
        userId,
        expiresAt: new Date(Date.now() + expiryMs),
        revoked: false,
      });
      return Promise.resolve(raw);
    }),
    findByRawToken: vi.fn((raw: string) => {
      const session = db.sessions.get(realSessions.hashToken(raw));
      if (!session) return Promise.resolve(null);
      const user = db.users.get(session.userId);
      if (!user) return Promise.resolve(null);
      return Promise.resolve({
        session_id: session.id,
        user_id: session.userId,
        expires_at: session.expiresAt.toISOString(),
        revoked: session.revoked ? 1 : 0,
        token_version: user.token_version,
        rank: user.rank,
        status: user.status,
      } as never);
    }),
    rotate: vi.fn((oldSessionId: string, userId: string, expiryMs: number) => {
      for (const session of db.sessions.values()) {
        if (session.id === oldSessionId) session.revoked = true;
      }
      const raw = realSessions.generateRawToken();
      db.sessions.set(realSessions.hashToken(raw), {
        id: `s-${db.sessions.size + 1}`,
        userId,
        expiresAt: new Date(Date.now() + expiryMs),
        revoked: false,
      });
      return Promise.resolve(raw);
    }),
    revokeAllForUser: vi.fn((userId: string) => {
      let count = 0;
      for (const session of db.sessions.values()) {
        if (session.userId === userId && !session.revoked) {
          session.revoked = true;
          count += 1;
        }
      }
      return Promise.resolve(count);
    }),
    deleteExpired: vi.fn(() => Promise.resolve(0)),
  };

  const permissionRepo = {
    findAllForUser: vi.fn((userId: string) =>
      Promise.resolve(
        (db.permissions.get(userId) ?? []).map(p => ({
          permission: p.permission,
          gammes: p.gammes,
          granted_by: 'seed',
          granted_at: new Date().toISOString(),
          expires_at: null,
        })) as never,
      ),
    ),
    findOne: vi.fn((userId: string, code: string) => {
      const found = (db.permissions.get(userId) ?? []).find(p => p.permission === code);
      return Promise.resolve(
        found
          ? ({
              permission: found.permission,
              gammes: found.gammes,
              granted_by: 'seed',
              granted_at: new Date().toISOString(),
              expires_at: null,
            } as never)
          : null,
      );
    }),
  };

  const auditRepo = {
    available: true,
    append: vi.fn((entry: Record<string, unknown>) => {
      db.auditLog.push({ ...entry, created_at: new Date().toISOString() });
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve(db.auditLog as never)),
  };

  const databaseStub = {
    enabled: true,
    onModuleInit: vi.fn(() => Promise.resolve()),
    onModuleDestroy: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve([])),
    queryOne: vi.fn(() => Promise.resolve(null)),
    execute: vi.fn(() => Promise.resolve(0)),
    transaction: vi.fn(),
  };

  // L'environnement est posé par `test/helpers/setup-env.ts` (setupFiles) : la
  // validation Zod s'exécute au chargement d'AppConfigModule, trop tôt pour être
  // configurée ici.

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue(databaseStub)
    .overrideProvider(UserRepository)
    .useValue(userRepo)
    .overrideProvider(SessionRepository)
    .useValue(sessionRepo)
    .overrideProvider(PermissionRepository)
    .useValue(permissionRepo)
    .overrideProvider(AuditRepository)
    .useValue(auditRepo)
    .compile();

  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => crypto.randomUUID(), trustProxy: true }),
  );

  // Mêmes plugins et mêmes réglages qu'en production : tester une application
  // assemblée autrement reviendrait à ne pas tester ce qui est déployé.
  const config = app.get(AppConfigService);
  const fastifyCookie = (await import('@fastify/cookie')).default;
  const helmet = (await import('@fastify/helmet')).default;
  await app.register(fastifyCookie, {
    parseOptions: { sameSite: 'strict', path: '/' },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", ...config.corsOrigins],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hidePoweredBy: true,
    noSniff: true,
  });

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req, reply, payload, done) => {
      void reply.header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
      );
      done(null, payload);
    });

  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  // Le service de mot de passe est remplacé par un double rapide : scrypt
  // rendrait la suite E2E interminable sans rien prouver de plus.
  const passwordService = app.get(
    (await import('../../src/security/password.service.js')).PasswordService,
  );
  vi.spyOn(passwordService, 'hash').mockImplementation(fastHash);
  vi.spyOn(passwordService, 'verify').mockImplementation(async (password, stored) => {
    return (await fastHash(password)) === stored;
  });

  for (const user of seed) {
    db.users.set(user.id, {
      id: user.id,
      username: user.username,
      password_hash: await fastHash(user.password),
      display_name: null,
      email: `${user.username}@exemple.fr`,
      rank: user.rank,
      status: user.status ?? 'active',
      token_version: 0,
      failed_logins: 0,
      locked_until: null,
    } as UserRow);
    db.passwords.set(user.id, user.password);
    if (user.permissions) db.permissions.set(user.id, user.permissions);
  }

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    db,
    url: (path: string) => `/${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`,
    close: () => app.close(),
  };
}

/** Extrait la valeur d'un cookie depuis les en-têtes `set-cookie` d'une réponse. */
export function cookieValue(setCookie: string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  for (const raw of setCookie) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(raw);
    if (match) return decodeURIComponent(match[1] ?? '');
  }
  return null;
}

/** Extrait les attributs d'un cookie (`HttpOnly`, `SameSite`, `Path`…). */
export function cookieAttributes(
  setCookie: string[] | undefined,
  name: string,
): Record<string, string | boolean> | null {
  if (!setCookie) return null;
  const raw = setCookie.find(c => c.startsWith(`${name}=`));
  if (!raw) return null;

  const attrs: Record<string, string | boolean> = {};
  for (const part of raw.split(';').slice(1)) {
    const [key, value] = part.trim().split('=');
    if (key) attrs[key.toLowerCase()] = value ?? true;
  }
  return attrs;
}
