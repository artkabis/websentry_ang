import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { API_PREFIX } from '../../src/common/constants.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import type { UserRow } from '../../src/database/repositories/user.repository.js';
import { UserRepository } from '../../src/database/repositories/user.repository.js';
import {
  UserAdminRepository,
  type AdminUserRow,
} from '../../src/database/repositories/user-admin.repository.js';
import { SessionRepository } from '../../src/database/repositories/session.repository.js';
import { PermissionRepository } from '../../src/database/repositories/permission.repository.js';
import { AuditRepository } from '../../src/database/repositories/audit.repository.js';
import { ProfileRepository } from '../../src/database/repositories/profile.repository.js';
import { ScanRepository } from '../../src/database/repositories/scan.repository.js';
import { ScanRetentionRepository } from '../../src/database/repositories/scan-retention.repository.js';
import { PageFetcherService } from '../../src/analysis/page-fetcher.service.js';

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

  /** Profils par gamme — reproduit la table `settings_profiles`. */
  readonly profiles = new Map<
    string,
    {
      gamme: string;
      label: string;
      description: string | null;
      settings: unknown;
      version: number;
      created_at: string;
      updated_at: string;
      updated_by: string | null;
    }
  >();

  /** Pages servies au moteur d'analyse, indexées par URL. */
  readonly pages = new Map<string, string>();

  /** Historique des scans — reproduit `sites`, `scan_sessions` et `scan_pages`. */
  readonly scanSites = new Map<string, FakeSite>();
  readonly scanSessions = new Map<string, FakeSession>();
  readonly scanPages = new Map<string, FakePage>();

  byUsername(username: string): UserRow | null {
    for (const user of this.users.values()) {
      if (user.username === username) return user;
    }
    return null;
  }
}

export interface FakeSite {
  id: string;
  domain: string;
  gamme: string | null;
  epj: string | null;
  metadata: unknown;
  last_seen: string;
}

export interface FakeSession {
  id: string;
  site_id: string;
  gamme: string | null;
  epj: string | null;
  platform: string | null;
  page_count: number;
  avg_score: number | null;
  min_score: number | null;
  max_score: number | null;
  analyzed_at: string;
  duration_ms: number | null;
  launched_by: string | null;
  profile_snapshot: unknown;
}

export interface FakePage {
  id: string;
  session_id: string;
  url: string;
  domain: string;
  global_score: number | null;
  status_code: number | null;
  analyzed_at: string;
  duration_ms: number | null;
  check_summary: unknown;
  report: string | null;
  report_gz: Buffer | null;
  is_compressed: number;
  report_purged_at: string | null;
}

export interface TestApp {
  app: NestFastifyApplication;
  db: FakeDb;
  /** Résout l'URL complète d'une route, préfixe global compris. */
  url(path: string): string;
  close(): Promise<void>;
}

/** Horodatage fixe des comptes amorcés — une date stable rend les tests lisibles. */
const MOMENT_AMORCAGE = '2026-01-01T00:00:00.000Z';

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

/** Options de montage — voir `realPageFetcher`. */
export interface TestAppOptions {
  /**
   * Monte la VRAIE récupération de page, donc la vraie politique SSRF.
   *
   * Par défaut, un double sert du HTML en mémoire : la suite teste les
   * décisions de l'API sans jamais sortir sur le réseau. Mais ce double
   * court-circuite la garde SSRF, qui n'était donc exercée par AUCUN test
   * passant par HTTP.
   *
   * Avec cette option, seules des adresses refusées AVANT toute connexion
   * doivent être visées — plages privées, boucle locale, protocoles
   * interdits : la garde tranche sur l'adresse, sans ouvrir de socket. Viser
   * un hôte public ferait sortir la suite sur Internet, ce qu'aucun test ne
   * doit faire.
   */
  realPageFetcher?: boolean;
}

export async function createTestApp(
  seed: SeedUser[] = [],
  options: TestAppOptions = {},
): Promise<TestApp> {
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

  const profileRepo = {
    available: true,
    list: vi.fn(() =>
      Promise.resolve(
        [...db.profiles.values()].sort((a, b) => {
          if (a.gamme === 'default') return -1;
          if (b.gamme === 'default') return 1;
          return a.gamme.localeCompare(b.gamme);
        }) as never,
      ),
    ),
    findByGamme: vi.fn((gamme: string) =>
      Promise.resolve((db.profiles.get(gamme) ?? null) as never),
    ),
    create: vi.fn(
      (
        gamme: string,
        label: string,
        description: string | null,
        settings: unknown,
        by: string | null,
      ) => {
        if (db.profiles.has(gamme)) return Promise.resolve(false);
        const now = new Date().toISOString();
        db.profiles.set(gamme, {
          gamme,
          label,
          description,
          settings,
          version: 1,
          created_at: now,
          updated_at: now,
          updated_by: by,
        });
        return Promise.resolve(true);
      },
    ),
    // Reproduit fidèlement l'atomicité du `UPDATE ... WHERE version = ?` :
    // une version attendue qui ne correspond plus ne touche aucune ligne.
    updateWithVersion: vi.fn(
      (
        gamme: string,
        label: string,
        description: string | null,
        settings: unknown,
        by: string | null,
        expectedVersion: number | null,
      ) => {
        const existing = db.profiles.get(gamme);
        if (!existing) return Promise.resolve(false);
        if (expectedVersion !== null && existing.version !== expectedVersion) {
          return Promise.resolve(false);
        }
        db.profiles.set(gamme, {
          ...existing,
          label,
          description,
          settings,
          updated_by: by,
          version: existing.version + 1,
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve(true);
      },
    ),
    delete: vi.fn((gamme: string) => {
      if (gamme === 'default') return Promise.resolve(false);
      return Promise.resolve(db.profiles.delete(gamme));
    }),
    currentVersion: vi.fn((gamme: string) =>
      Promise.resolve(db.profiles.get(gamme)?.version ?? null),
    ),
  };

  // ── Historique des scans ────────────────────────────────────────────────────
  // Le double reproduit les SÉMANTIQUES qui portent une décision — jointure
  // site/session/page, filtres, pagination, cascade de suppression, distinction
  // du rapport purgé — et non le dialecte SQL, couvert par les tests unitaires
  // du repository.

  const identityOf = (domain: string, gamme: string | null) => `${domain}|${gamme ?? ''}`;

  const siteOfSession = (sessionId: string): FakeSite | null => {
    const session = db.scanSessions.get(sessionId);
    return session ? (db.scanSites.get(session.site_id) ?? null) : null;
  };

  /** Ligne « page » telle que la produit la jointure des trois tables. */
  const joinPage = (page: FakePage) => {
    const session = db.scanSessions.get(page.session_id);
    const site = session ? db.scanSites.get(session.site_id) : null;
    return {
      ...page,
      gamme: site?.gamme ?? null,
      epj: site?.epj ?? null,
      platform: session?.platform ?? null,
      metadata: site?.metadata ?? null,
      launched_by: session?.launched_by ?? null,
      has_report: page.report != null || page.report_gz != null ? 1 : 0,
      site_domain: site?.domain ?? page.domain,
    };
  };

  const matchesText = (value: string | null, needle: string | undefined) =>
    !needle || (value ?? '').toLowerCase().includes(needle.toLowerCase());

  const withinDates = (at: string, from?: string, to?: string) => {
    const iso = at.replace(' ', 'T');
    if (from && iso < from.slice(0, 10)) return false;
    if (to && iso.slice(0, 10) > to.slice(0, 10)) return false;
    return true;
  };

  interface FakeQuery {
    q?: string;
    domain?: string;
    gamme?: string;
    epj?: string;
    scoreMin?: number;
    scoreMax?: number;
    dateFrom?: string;
    dateTo?: string;
    sessionId?: string;
  }

  const filterPages = (params: FakeQuery) =>
    [...db.scanPages.values()].map(joinPage).filter(row => {
      if (params.sessionId && row.session_id !== params.sessionId) return false;
      if (!matchesText(row.site_domain, params.domain)) return false;
      if (params.gamme && row.gamme !== params.gamme) return false;
      if (!matchesText(row.epj, params.epj)) return false;
      if (params.q && !matchesText(`${row.site_domain} ${row.epj ?? ''}`, params.q)) return false;
      if (params.scoreMin != null && (row.global_score ?? -1) < params.scoreMin) return false;
      if (params.scoreMax != null && (row.global_score ?? 99) > params.scoreMax) return false;
      return withinDates(row.analyzed_at, params.dateFrom, params.dateTo);
    });

  /** Chaque site avec sa session la plus récente — équivalent du ROW_NUMBER(). */
  const siteRows = (params: FakeQuery) =>
    [...db.scanSites.values()]
      .map(site => {
        const sessions = [...db.scanSessions.values()]
          .filter(s => s.site_id === site.id)
          .sort((a, b) => b.analyzed_at.localeCompare(a.analyzed_at));
        const last = sessions[0] ?? null;
        return {
          site_id: site.id,
          domain: site.domain,
          gamme: site.gamme,
          epj: site.epj,
          metadata: site.metadata,
          last_session_id: last?.id ?? null,
          page_count: last?.page_count ?? null,
          avg_score: last?.avg_score ?? null,
          min_score: last?.min_score ?? null,
          max_score: last?.max_score ?? null,
          launched_by: last?.launched_by ?? null,
          last_scan: last?.analyzed_at ?? site.last_seen,
          session_count: sessions.length,
        };
      })
      .filter(row => {
        if (!matchesText(row.domain, params.domain)) return false;
        if (params.gamme && row.gamme !== params.gamme) return false;
        if (!matchesText(row.epj, params.epj)) return false;
        if (params.q && !matchesText(`${row.domain} ${row.epj ?? ''}`, params.q)) return false;
        if (params.scoreMin != null && (row.avg_score ?? -1) < params.scoreMin) return false;
        if (params.scoreMax != null && (row.avg_score ?? 99) > params.scoreMax) return false;
        return withinDates(row.last_scan, params.dateFrom, params.dateTo);
      });

  const sessionRow = (session: FakeSession) => ({
    ...session,
    domain: db.scanSites.get(session.site_id)?.domain ?? '',
  });

  const scanRepo = {
    available: true,
    countPages: vi.fn((params: FakeQuery) => Promise.resolve(filterPages(params).length)),
    searchPages: vi.fn((params: FakeQuery, limit: number, offset: number) =>
      Promise.resolve(
        filterPages(params)
          .sort((a, b) => b.analyzed_at.localeCompare(a.analyzed_at) || a.id.localeCompare(b.id))
          .slice(offset, offset + limit),
      ),
    ),
    countSites: vi.fn((params: FakeQuery) => Promise.resolve(siteRows(params).length)),
    listSites: vi.fn((params: FakeQuery, limit: number, offset: number) =>
      Promise.resolve(
        siteRows(params)
          .sort((a, b) => b.last_scan.localeCompare(a.last_scan))
          .slice(offset, offset + limit),
      ),
    ),
    listSiteSessions: vi.fn((domain: string, gamme: string | null) => {
      const site = [...db.scanSites.values()].find(
        s => identityOf(s.domain, s.gamme) === identityOf(domain, gamme),
      );
      if (!site) return Promise.resolve([]);
      return Promise.resolve(
        [...db.scanSessions.values()]
          .filter(s => s.site_id === site.id)
          .sort((a, b) => b.analyzed_at.localeCompare(a.analyzed_at))
          .map(sessionRow),
      );
    }),
    findPageWithReport: vi.fn((id: string) => {
      const page = db.scanPages.get(id);
      return Promise.resolve(page ? joinPage(page) : null);
    }),
    findSession: vi.fn((id: string) => {
      const session = db.scanSessions.get(id);
      return Promise.resolve(session ? sessionRow(session) : null);
    }),
    listSessionPages: vi.fn((sessionId: string, limit: number) =>
      Promise.resolve(
        [...db.scanPages.values()]
          .filter(p => p.session_id === sessionId)
          .sort((a, b) => a.analyzed_at.localeCompare(b.analyzed_at))
          .slice(0, limit),
      ),
    ),
    listComparablePages: vi.fn((sessionId: string, limit: number) =>
      Promise.resolve(
        [...db.scanPages.values()]
          .filter(p => p.session_id === sessionId)
          .slice(0, limit)
          .map(p => ({ url: p.url, global_score: p.global_score, check_summary: p.check_summary })),
      ),
    ),
    findSessionIdsForPages: vi.fn((ids: readonly string[]) =>
      Promise.resolve([
        ...new Set(ids.map(id => db.scanPages.get(id)?.session_id).filter(Boolean)),
      ] as string[]),
    ),
    deletePages: vi.fn((ids: readonly string[]) => {
      let deleted = 0;
      for (const id of ids) if (db.scanPages.delete(id)) deleted += 1;
      return Promise.resolve(deleted);
    }),
    countPagesForSite: vi.fn((domain: string, gamme: string | null) =>
      Promise.resolve(
        [...db.scanPages.values()].filter(p => {
          const site = siteOfSession(p.session_id);
          return site && identityOf(site.domain, site.gamme) === identityOf(domain, gamme);
        }).length,
      ),
    ),
    countPagesForDomain: vi.fn((domain: string) =>
      Promise.resolve(
        [...db.scanPages.values()].filter(p => siteOfSession(p.session_id)?.domain === domain)
          .length,
      ),
    ),
    countPagesForSession: vi.fn((sessionId: string) =>
      Promise.resolve([...db.scanPages.values()].filter(p => p.session_id === sessionId).length),
    ),
    deleteSite: vi.fn((domain: string, gamme: string | null) => {
      const sites = [...db.scanSites.values()].filter(
        s => identityOf(s.domain, s.gamme) === identityOf(domain, gamme),
      );
      for (const site of sites) cascadeDeleteSite(site.id);
      return Promise.resolve(sites.length);
    }),
    deleteDomain: vi.fn((domain: string) => {
      const sites = [...db.scanSites.values()].filter(s => s.domain === domain);
      for (const site of sites) cascadeDeleteSite(site.id);
      return Promise.resolve(sites.length);
    }),
    deleteSession: vi.fn((sessionId: string) => {
      for (const page of [...db.scanPages.values()]) {
        if (page.session_id === sessionId) db.scanPages.delete(page.id);
      }
      return Promise.resolve(db.scanSessions.delete(sessionId) ? 1 : 0);
    }),
    reconcileSessions: vi.fn((ids: readonly string[]) => {
      for (const id of new Set(ids)) {
        const session = db.scanSessions.get(id);
        if (!session) continue;
        const pages = [...db.scanPages.values()].filter(p => p.session_id === id);
        if (pages.length === 0) {
          db.scanSessions.delete(id);
          continue;
        }
        const scores = pages.map(p => p.global_score).filter((s): s is number => s != null);
        session.page_count = pages.length;
        session.avg_score = scores.length
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : null;
        session.min_score = scores.length ? Math.min(...scores) : null;
        session.max_score = scores.length ? Math.max(...scores) : null;
      }
      return Promise.resolve();
    }),
    deleteOrphanSites: vi.fn(() => {
      let removed = 0;
      for (const site of [...db.scanSites.values()]) {
        const hasSession = [...db.scanSessions.values()].some(s => s.site_id === site.id);
        if (!hasSession && db.scanSites.delete(site.id)) removed += 1;
      }
      return Promise.resolve(removed);
    }),
    statsSummary: vi.fn(() => {
      const pages = [...db.scanPages.values()];
      const scores = pages.map(p => p.global_score).filter((s): s is number => s != null);
      const dates = pages.map(p => p.analyzed_at).sort();
      return Promise.resolve({
        total: pages.length,
        inline: pages.filter(p => p.report != null).length,
        compressed: pages.filter(p => p.is_compressed === 1 && p.report_gz != null).length,
        purged: pages.filter(p => p.report == null && p.report_gz == null).length,
        avg_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        oldest: dates[0] ?? null,
        newest: dates[dates.length - 1] ?? null,
        storage_gz: pages.reduce((sum, p) => sum + (p.report_gz?.length ?? 0), 0),
      });
    }),
    countRows: vi.fn((table: 'sites' | 'scan_sessions') =>
      Promise.resolve(table === 'sites' ? db.scanSites.size : db.scanSessions.size),
    ),
    statsByGamme: vi.fn(() => Promise.resolve([])),
    statsScoreBuckets: vi.fn(() =>
      Promise.resolve({ good: 0, warning: 0, critical: 0, unknown: 0 }),
    ),
    statsTopDomains: vi.fn(() => Promise.resolve([])),
    ingestSession: vi.fn(() => Promise.resolve()),
  };

  /** Cascade `ON DELETE CASCADE` du schéma : site → sessions → pages. */
  function cascadeDeleteSite(siteId: string): void {
    for (const session of [...db.scanSessions.values()]) {
      if (session.site_id !== siteId) continue;
      for (const page of [...db.scanPages.values()]) {
        if (page.session_id === session.id) db.scanPages.delete(page.id);
      }
      db.scanSessions.delete(session.id);
    }
    db.scanSites.delete(siteId);
  }

  const scanRetentionRepo = {
    available: true,
    findCompressible: vi.fn(() => Promise.resolve([])),
    compress: vi.fn(() => Promise.resolve(0)),
    purge: vi.fn(() => Promise.resolve(0)),
    countPending: vi.fn(() => Promise.resolve({ compressible: 0, purgeable: 0 })),
  };

  /**
   * Administration des comptes, adossée à la MÊME table simulée que
   * l'authentification : un compte créé ici doit pouvoir se connecter ensuite,
   * et un compte suspendu ici doit se voir refuser son jeton.
   */
  function versAdmin(ligne: UserRow): AdminUserRow {
    const brut = ligne as unknown as {
      total_scans_launched?: number;
      created_at?: string;
      updated_at?: string;
    };
    return {
      id: ligne.id,
      username: ligne.username,
      display_name: ligne.display_name,
      email: ligne.email,
      rank: ligne.rank,
      status: ligne.status,
      locked_until: ligne.locked_until,
      total_scans_launched: brut.total_scans_launched ?? 0,
      created_at: brut.created_at ?? MOMENT_AMORCAGE,
      updated_at: brut.updated_at ?? MOMENT_AMORCAGE,
    } as AdminUserRow;
  }

  function filtrer(filters: { search?: string; rank?: number; status?: string }): AdminUserRow[] {
    const motif = filters.search?.toLowerCase();
    return [...db.users.values()]
      .filter(u => {
        if (filters.rank !== undefined && u.rank !== filters.rank) return false;
        if (filters.status !== undefined && u.status !== filters.status) return false;
        if (motif === undefined) return true;
        return [u.username, u.display_name, u.email].some(champ =>
          (champ ?? '').toLowerCase().includes(motif),
        );
      })
      .sort((a, b) => b.rank - a.rank || a.username.localeCompare(b.username))
      .map(versAdmin);
  }

  const userAdminRepo = {
    available: true,
    list: vi.fn((filters: never, limit: number, offset: number) =>
      Promise.resolve(filtrer(filters).slice(offset, offset + limit)),
    ),
    count: vi.fn((filters: never) => Promise.resolve(filtrer(filters).length)),
    findById: vi.fn((id: string) => {
      const ligne = db.users.get(id);
      return Promise.resolve(ligne ? versAdmin(ligne) : null);
    }),
    countActiveAtLeastRank: vi.fn((rank: number) =>
      Promise.resolve(
        [...db.users.values()].filter(u => u.rank >= rank && u.status === 'active').length,
      ),
    ),
    create: vi.fn(
      (compte: {
        id: string;
        username: string;
        passwordHash: string;
        rank: number;
        displayName: string | null;
        email: string | null;
      }) => {
        const maintenant = new Date().toISOString();
        db.users.set(compte.id, {
          id: compte.id,
          username: compte.username,
          password_hash: compte.passwordHash,
          display_name: compte.displayName,
          email: compte.email,
          rank: compte.rank,
          status: 'active',
          token_version: 0,
          failed_logins: 0,
          locked_until: null,
          total_scans_launched: 0,
          created_at: maintenant,
          updated_at: maintenant,
        } as unknown as UserRow);
        return Promise.resolve();
      },
    ),
    update: vi.fn(
      (
        id: string,
        champs: Partial<{
          rank: number;
          status: 'active' | 'suspended' | 'pending';
          display_name: string | null;
          email: string | null;
        }>,
      ) => {
        const ligne = db.users.get(id);
        if (!ligne) return Promise.resolve(0);
        // Seuls les champs FOURNIS sont écrits — reproduire ici la mise à jour
        // partielle du dépôt réel, sinon le test ne prouverait rien.
        for (const [colonne, valeur] of Object.entries(champs)) {
          if (valeur !== undefined) {
            (ligne as unknown as Record<string, unknown>)[colonne] = valeur;
          }
        }
        (ligne as unknown as Record<string, unknown>)['updated_at'] = new Date().toISOString();
        return Promise.resolve(1);
      },
    ),
    updatePassword: vi.fn((id: string, passwordHash: string) => {
      const ligne = db.users.get(id);
      if (!ligne) return Promise.resolve(0);
      ligne.password_hash = passwordHash;
      ligne.failed_logins = 0;
      ligne.locked_until = null;
      ligne.token_version += 1;
      return Promise.resolve(1);
    }),
    delete: vi.fn((id: string) => {
      db.permissions.delete(id);
      return Promise.resolve(db.users.delete(id) ? 1 : 0);
    }),
    list_permissions: vi.fn((userId: string) =>
      Promise.resolve(
        (db.permissions.get(userId) ?? []).map(p => ({
          permission: p.permission,
          gammes: p.gammes,
          granted_by: 'seed',
          granted_at: MOMENT_AMORCAGE,
          expires_at: null,
        })) as never,
      ),
    ),
    grantPermission: vi.fn(
      (octroi: { userId: string; permission: string; gammes: string[] | null }) => {
        const liste = db.permissions.get(octroi.userId) ?? [];
        const existante = liste.find(p => p.permission === octroi.permission);
        if (existante) existante.gammes = octroi.gammes;
        else liste.push({ permission: octroi.permission, gammes: octroi.gammes });
        db.permissions.set(octroi.userId, liste);
        return Promise.resolve();
      },
    ),
    revokePermission: vi.fn((userId: string, permission: string) => {
      const liste = db.permissions.get(userId) ?? [];
      const reste = liste.filter(p => p.permission !== permission);
      db.permissions.set(userId, reste);
      return Promise.resolve(liste.length - reste.length);
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

  // ── Récupération de page ────────────────────────────────────────────────────
  // Le double sert du HTML en mémoire : la suite E2E teste les DÉCISIONS de
  // l'API (accès, validation, forme des réponses), pas la pile réseau — que
  // couvrent les tests du service SSRF. Aucun test ne doit sortir sur Internet.
  const pageFetcher = {
    fetchPage: vi.fn((url: string) => {
      const html = db.pages.get(url);
      if (html === undefined) {
        return Promise.reject(new Error(`Hôte injoignable : ${url}`));
      }
      return Promise.resolve({
        url,
        html,
        title: 'Page de test',
        platform: 'generic' as const,
        headers: { 'content-type': 'text/html' },
        statusCode: 200,
        ttfb: 12,
        redirectChain: [],
      });
    }),
  };

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue(databaseStub)
    .overrideProvider(UserRepository)
    .useValue(userRepo)
    .overrideProvider(UserAdminRepository)
    .useValue(userAdminRepo)
    .overrideProvider(SessionRepository)
    .useValue(sessionRepo)
    .overrideProvider(PermissionRepository)
    .useValue(permissionRepo)
    .overrideProvider(AuditRepository)
    .useValue(auditRepo)
    .overrideProvider(ProfileRepository)
    .useValue(profileRepo)
    .overrideProvider(ScanRepository)
    .useValue(scanRepo)
    .overrideProvider(ScanRetentionRepository)
    .useValue(scanRetentionRepo);

  if (!options.realPageFetcher) {
    builder.overrideProvider(PageFetcherService).useValue(pageFetcher);
  }

  const moduleRef = await builder.compile();

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
      // Colonnes d'administration : absentes de `UserRow` (qui ne décrit que
      // l'authentification) mais bien présentes dans la table `users`.
      total_scans_launched: 0,
      created_at: MOMENT_AMORCAGE,
      updated_at: MOMENT_AMORCAGE,
    } as unknown as UserRow);
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
