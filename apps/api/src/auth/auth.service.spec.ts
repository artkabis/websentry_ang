import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { RANKS } from '@websentry/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { SessionRepository, SessionRow } from '../database/repositories/session.repository.js';
import type { UserRepository, UserRow } from '../database/repositories/user.repository.js';
import type { RbacService } from '../rbac/rbac.service.js';
import type { PasswordService } from '../security/password.service.js';
import { AuthService } from './auth.service.js';
import type { LoginThrottleService } from './login-throttle.service.js';
import type { TokenService } from './token.service.js';

const CTX = { ip: '203.0.113.10', userAgent: 'Mozilla/5.0' };

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u1',
    username: 'alice',
    password_hash: 'sel:empreinte',
    display_name: null,
    email: 'alice@exemple.fr',
    rank: RANKS.TESTER,
    status: 'active',
    token_version: 2,
    failed_logins: 0,
    locked_until: null,
    ...over,
  } as UserRow;
}

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 's1',
    user_id: 'u1',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    revoked: 0,
    token_version: 2,
    rank: RANKS.TESTER,
    status: 'active',
    ...over,
  } as SessionRow;
}

function build() {
  const users = {
    available: true,
    findByUsername: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(userRow()),
    recordFailedLogin: vi.fn().mockResolvedValue(undefined),
    resetFailedLogins: vi.fn().mockResolvedValue(undefined),
    bumpTokenVersion: vi.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    create: vi.fn().mockResolvedValue('refresh-brut'),
    findByRawToken: vi.fn().mockResolvedValue(null),
    rotate: vi.fn().mockResolvedValue('refresh-neuf'),
    revokeAllForUser: vi.fn().mockResolvedValue(1),
  };
  const tokens = { sign: vi.fn().mockResolvedValue('access-jwt'), verify: vi.fn() };
  const passwords = {
    hash: vi.fn().mockResolvedValue('sel:factice'),
    verify: vi.fn().mockResolvedValue(false),
  };
  const rbac = { listForUser: vi.fn().mockResolvedValue([]) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const throttle = { hit: vi.fn().mockReturnValue(0), clear: vi.fn() };
  const config = {
    accessTokenTtl: 900,
    refreshTokenTtl: 604_800,
    loginMaxAttempts: 5,
    loginLockoutSeconds: 900,
  };

  const service = new AuthService(
    users as unknown as UserRepository,
    sessions as unknown as SessionRepository,
    tokens as unknown as TokenService,
    passwords as unknown as PasswordService,
    rbac as unknown as RbacService,
    audit as unknown as AuditService,
    throttle as unknown as LoginThrottleService,
    config as unknown as AppConfigService,
  );

  return { service, users, sessions, tokens, passwords, rbac, audit, throttle, config };
}

describe('AuthService', () => {
  describe('login — chemin nominal', () => {
    it('émet des jetons et renvoie le rôle dérivé du rang', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ rank: RANKS.ADMIN }));
      t.passwords.verify.mockResolvedValue(true);

      const issued = await t.service.login('Alice', 'bon-mot-de-passe', CTX);

      expect(issued).toMatchObject({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-brut',
        role: 'admin',
        username: 'alice',
      });
      expect(issued.csrfToken).toHaveLength(32); // 24 octets en base64url
    });

    it('normalise l’identifiant en minuscules et sans espaces', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow());
      t.passwords.verify.mockResolvedValue(true);

      await t.service.login('  ALICE  ', 'mdp', CTX);
      expect(t.users.findByUsername).toHaveBeenCalledWith('alice');
    });

    it('remet à zéro le compteur d’échecs et le limiteur', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ failed_logins: 3 }));
      t.passwords.verify.mockResolvedValue(true);

      await t.service.login('alice', 'mdp', CTX);
      expect(t.users.resetFailedLogins).toHaveBeenCalledWith('u1');
      expect(t.throttle.clear).toHaveBeenCalledWith(CTX.ip, 'alice');
    });

    it('signe le jeton avec la version courante — support de la révocation', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ token_version: 7 }));
      t.passwords.verify.mockResolvedValue(true);

      await t.service.login('alice', 'mdp', CTX);
      expect(t.tokens.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'u1', rank: RANKS.TESTER, version: 7 }),
        900,
      );
    });

    it('plafonne le TTL de l’access token à 15 minutes', async () => {
      const t = build();
      // Une configuration laxiste ne doit pas allonger la durée de vie d'un jeton.
      (t.config as { accessTokenTtl: number }).accessTokenTtl = 86_400;
      t.users.findByUsername.mockResolvedValue(userRow());
      t.passwords.verify.mockResolvedValue(true);

      const issued = await t.service.login('alice', 'mdp', CTX);
      expect(issued.accessMaxAge).toBe(900);
    });

    it('journalise la connexion réussie', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow());
      t.passwords.verify.mockResolvedValue(true);

      await t.service.login('alice', 'mdp', CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login', actorId: 'u1' }),
      );
    });
  });

  describe('login — identifiants invalides', () => {
    it('refuse un mot de passe incorrect', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow());
      t.passwords.verify.mockResolvedValue(false);

      await expect(t.service.login('alice', 'mauvais', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse un identifiant inconnu avec le MÊME message — pas d’oracle d’énumération', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(null);

      const unknown = await t.service.login('inconnu', 'mdp', CTX).catch((e: Error) => e.message);
      t.users.findByUsername.mockResolvedValue(userRow());
      const wrongPassword = await t.service
        .login('alice', 'mauvais', CTX)
        .catch((e: Error) => e.message);

      expect(unknown).toBe(wrongPassword);
    });

    it('vérifie un hash FACTICE sur identifiant inconnu — le coût scrypt est toujours payé', async () => {
      // Sans cela, la réponse immédiate sur compte inexistant révélerait au
      // chronomètre quels identifiants existent.
      const t = build();
      t.users.findByUsername.mockResolvedValue(null);

      await expect(t.service.login('inconnu', 'mdp', CTX)).rejects.toThrow();
      expect(t.passwords.hash).toHaveBeenCalled();
      expect(t.passwords.verify).toHaveBeenCalledWith('mdp', 'sel:factice');
    });

    it('ne calcule le hash factice qu’UNE FOIS, puis le réutilise', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(null);

      await t.service.login('a', 'mdp', CTX).catch(() => undefined);
      await t.service.login('b', 'mdp', CTX).catch(() => undefined);
      expect(t.passwords.hash).toHaveBeenCalledTimes(1);
    });

    it('incrémente le compteur d’échecs d’un compte existant', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ failed_logins: 2 }));

      await expect(t.service.login('alice', 'mauvais', CTX)).rejects.toThrow();
      expect(t.users.recordFailedLogin).toHaveBeenCalledWith('u1', 3, null);
    });

    it('VERROUILLE le compte au seuil d’échecs configuré', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ failed_logins: 4 }));

      await expect(t.service.login('alice', 'mauvais', CTX)).rejects.toThrow();
      const [, failed, lockedUntil] = t.users.recordFailedLogin.mock.calls[0] as [
        string,
        number,
        Date | null,
      ];
      expect(failed).toBe(5);
      expect(lockedUntil).toBeInstanceOf(Date);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.account_locked' }),
      );
    });

    it('n’incrémente rien pour un identifiant inconnu', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(null);

      await expect(t.service.login('inconnu', 'mdp', CTX)).rejects.toThrow();
      expect(t.users.recordFailedLogin).not.toHaveBeenCalled();
    });

    it('journalise l’échec même si l’écriture du compteur échoue', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow());
      t.users.recordFailedLogin.mockRejectedValue(new Error('base indisponible'));

      await expect(t.service.login('alice', 'mauvais', CTX)).rejects.toThrow(UnauthorizedException);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login_failed' }),
      );
    });
  });

  describe('login — état du compte', () => {
    it('refuse un compte verrouillé, avec un Retry-After', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(
        userRow({ locked_until: new Date(Date.now() + 300_000).toISOString() }),
      );
      t.passwords.verify.mockResolvedValue(true);

      const err = (await t.service.login('alice', 'mdp', CTX).catch(e => e)) as HttpException;
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect((err.getResponse() as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    });

    it('accepte un compte dont le verrou est ÉCHU', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(
        userRow({ locked_until: new Date(Date.now() - 1000).toISOString() }),
      );
      t.passwords.verify.mockResolvedValue(true);

      await expect(t.service.login('alice', 'mdp', CTX)).resolves.toMatchObject({
        username: 'alice',
      });
    });

    it('ne révèle le verrouillage qu’APRÈS validation du mot de passe', async () => {
      // Sinon l'état de verrouillage devient lui-même un oracle d'énumération.
      const t = build();
      t.users.findByUsername.mockResolvedValue(
        userRow({ locked_until: new Date(Date.now() + 300_000).toISOString() }),
      );
      t.passwords.verify.mockResolvedValue(false);

      await expect(t.service.login('alice', 'mauvais', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse un compte suspendu', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ status: 'suspended' }));
      t.passwords.verify.mockResolvedValue(true);

      await expect(t.service.login('alice', 'mdp', CTX)).rejects.toThrow(ForbiddenException);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: { reason: 'account_suspended' } }),
      );
    });

    it('refuse un compte en attente d’activation', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow({ status: 'pending' }));
      t.passwords.verify.mockResolvedValue(true);

      await expect(t.service.login('alice', 'mdp', CTX)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('login — limitation de débit', () => {
    it('refuse 429 quand le limiteur par (IP, identifiant) est saturé', async () => {
      const t = build();
      t.throttle.hit.mockReturnValue(42);

      const err = (await t.service.login('alice', 'mdp', CTX).catch(e => e)) as HttpException;
      expect(err.getStatus()).toBe(429);
      expect((err.getResponse() as { retryAfter: number }).retryAfter).toBe(42);
    });

    it('applique la limite AVANT toute requête en base', async () => {
      const t = build();
      t.throttle.hit.mockReturnValue(30);

      await expect(t.service.login('alice', 'mdp', CTX)).rejects.toThrow();
      expect(t.users.findByUsername).not.toHaveBeenCalled();
    });

    it('utilise "unknown" comme clé quand l’IP est absente', async () => {
      const t = build();
      await t.service.login('alice', 'mdp', { ip: null, userAgent: null }).catch(() => undefined);
      expect(t.throttle.hit).toHaveBeenCalledWith('unknown', 'alice');
    });
  });

  describe('login — indisponibilité', () => {
    it('répond 503 quand aucune base n’est configurée', async () => {
      const t = build();
      (t.users as { available: boolean }).available = false;

      await expect(t.service.login('alice', 'mdp', CTX)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('refresh — rotation', () => {
    it('révoque l’ancienne session et en émet une neuve', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow());

      const issued = await t.service.refresh('refresh-brut', CTX);

      expect(t.sessions.rotate).toHaveBeenCalledWith('s1', 'u1', 604_800_000, CTX.ip, CTX.userAgent);
      expect(issued.refreshToken).toBe('refresh-neuf');
    });

    it('émet un jeton CSRF neuf à chaque rotation', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow());

      const first = await t.service.refresh('a', CTX);
      const second = await t.service.refresh('b', CTX);
      expect(first.csrfToken).not.toBe(second.csrfToken);
    });

    it('refuse un refresh token inconnu', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(null);
      await expect(t.service.refresh('inconnu', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse un refresh token DÉJÀ utilisé — la rotation l’a révoqué', async () => {
      // C'est la détection de rejeu : un jeton volé puis présenté après un refresh
      // légitime tombe sur une ligne révoquée.
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow({ revoked: 1 }));
      await expect(t.service.refresh('rejoue', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse une session expirée', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(
        sessionRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      );
      await expect(t.service.refresh('perime', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it.each(['suspended', 'pending'] as const)(
      'refuse la session d’un compte au statut %s',
      async status => {
        const t = build();
        t.sessions.findByRawToken.mockResolvedValue(sessionRow({ status }));
        await expect(t.service.refresh('jeton', CTX)).rejects.toThrow(UnauthorizedException);
      },
    );

    it('refuse quand l’utilisateur a disparu entre-temps', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow());
      t.users.findById.mockResolvedValue(null);
      await expect(t.service.refresh('jeton', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('refuse quand l’utilisateur a été désactivé entre-temps', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow());
      t.users.findById.mockResolvedValue(userRow({ status: 'suspended' }));
      await expect(t.service.refresh('jeton', CTX)).rejects.toThrow(UnauthorizedException);
    });

    it('répond 503 quand aucune base n’est configurée', async () => {
      const t = build();
      (t.users as { available: boolean }).available = false;
      await expect(t.service.refresh('jeton', CTX)).rejects.toThrow(ServiceUnavailableException);
    });

    it('journalise la rotation', async () => {
      const t = build();
      t.sessions.findByRawToken.mockResolvedValue(sessionRow());
      await t.service.refresh('jeton', CTX);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh' }),
      );
    });
  });

  describe('logout', () => {
    it('révoque TOUTES les sessions de l’utilisateur', async () => {
      const t = build();
      await t.service.logout('u1', 'alice', CTX.ip);
      expect(t.sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
    });

    it('journalise la déconnexion', async () => {
      const t = build();
      await t.service.logout('u1', 'alice', CTX.ip);
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.logout', actorId: 'u1' }),
      );
    });

    it('reste idempotent si la révocation échoue', async () => {
      const t = build();
      t.sessions.revokeAllForUser.mockRejectedValue(new Error('base indisponible'));
      await expect(t.service.logout('u1', 'alice', CTX.ip)).resolves.toBeUndefined();
    });

    it('n’interroge pas la base quand aucune n’est configurée', async () => {
      const t = build();
      (t.users as { available: boolean }).available = false;
      await t.service.logout('u1', 'alice', CTX.ip);
      expect(t.sessions.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('currentUser', () => {
    it('renvoie un profil filtré, sans aucun champ sensible', async () => {
      const t = build();
      t.users.findById.mockResolvedValue(userRow({ rank: RANKS.ADMIN }));
      t.rbac.listForUser.mockResolvedValue([{ permission: 'docs:read', gammes: null }]);

      const profile = await t.service.currentUser('u1');

      expect(profile).toEqual({
        id: 'u1',
        username: 'alice',
        rank: RANKS.ADMIN,
        role: 'admin',
        status: 'active',
        permissions: [{ permission: 'docs:read', gammes: null }],
      });
      // Liste blanche : ces champs ne doivent jamais franchir la frontière HTTP.
      expect(profile).not.toHaveProperty('password_hash');
      expect(profile).not.toHaveProperty('token_version');
      expect(profile).not.toHaveProperty('failed_logins');
      expect(profile).not.toHaveProperty('locked_until');
      expect(profile).not.toHaveProperty('email');
    });

    it('refuse quand l’utilisateur est introuvable', async () => {
      const t = build();
      t.users.findById.mockResolvedValue(null);
      await expect(t.service.currentUser('fantome')).rejects.toThrow(UnauthorizedException);
    });

    it('dégrade en liste vide si les permissions sont illisibles', async () => {
      const t = build();
      t.rbac.listForUser.mockRejectedValue(new Error('base indisponible'));
      await expect(t.service.currentUser('u1')).resolves.toMatchObject({ permissions: [] });
    });
  });

  describe('toAuthSession', () => {
    it('ne laisse filtrer AUCUN jeton dans la réponse HTTP', async () => {
      const t = build();
      t.users.findByUsername.mockResolvedValue(userRow());
      t.passwords.verify.mockResolvedValue(true);

      const issued = await t.service.login('alice', 'mdp', CTX);
      expect(t.service.toAuthSession(issued)).toEqual({ role: 'tester', username: 'alice' });
    });
  });
});
