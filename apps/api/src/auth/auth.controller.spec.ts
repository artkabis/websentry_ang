import { UnauthorizedException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { COOKIES, REFRESH_COOKIE_PATH } from '../common/constants.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import type { AppConfigService } from '../config/app-config.service.js';
import { AuthController } from './auth.controller.js';
import type { AuthService, IssuedTokens } from './auth.service.js';

const ISSUED: IssuedTokens = {
  accessToken: 'access-jwt',
  accessMaxAge: 900,
  refreshToken: 'refresh-brut',
  refreshMaxAge: 604_800,
  csrfToken: 'csrf-token',
  role: 'admin',
  username: 'alice',
};

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: 50, version: 0 };

interface CookieCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function build(isProduction = true) {
  const cookies: CookieCall[] = [];
  const reply = {
    setCookie: (name: string, value: string, options: Record<string, unknown>) => {
      cookies.push({ name, value, options });
      return reply;
    },
  } as unknown as FastifyReply;

  const auth = {
    login: vi.fn().mockResolvedValue(ISSUED),
    refresh: vi.fn().mockResolvedValue(ISSUED),
    logout: vi.fn().mockResolvedValue(undefined),
    currentUser: vi.fn().mockResolvedValue({ id: 'u1', username: 'alice' }),
    toAuthSession: (i: IssuedTokens) => ({ role: i.role, username: i.username }),
  };

  const config = {
    cookieBase: {
      httpOnly: true as const,
      secure: isProduction,
      sameSite: 'strict' as const,
      path: '/',
    },
  } as AppConfigService;

  return {
    controller: new AuthController(auth as unknown as AuthService, config),
    auth,
    reply,
    cookies,
    find: (name: string) => cookies.find(c => c.name === name),
  };
}

function req(over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    ip: '203.0.113.10',
    headers: { 'user-agent': 'Mozilla/5.0' },
    cookies: {},
    ...over,
  } as AuthenticatedRequest;
}

describe('AuthController', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  describe('login', () => {
    it('renvoie UNIQUEMENT le rôle et le nom — aucun jeton dans le corps', async () => {
      // Les jetons vivent en cookies httpOnly : un XSS ne doit pas pouvoir les lire.
      const body = await t.controller.login({ username: 'alice', password: 'mdp' }, req(), t.reply);
      expect(body).toEqual({ role: 'admin', username: 'alice' });
      expect(JSON.stringify(body)).not.toContain('access-jwt');
      expect(JSON.stringify(body)).not.toContain('refresh-brut');
    });

    it('transmet l’IP et le User-Agent au service', async () => {
      await t.controller.login({ username: 'alice', password: 'mdp' }, req(), t.reply);
      expect(t.auth.login).toHaveBeenCalledWith('alice', 'mdp', {
        ip: '203.0.113.10',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('tolère l’absence d’IP et de User-Agent', async () => {
      await t.controller.login(
        { username: 'alice', password: 'mdp' },
        req({ ip: undefined, headers: {} }),
        t.reply,
      );
      expect(t.auth.login).toHaveBeenCalledWith('alice', 'mdp', { ip: null, userAgent: null });
    });

    describe('cookies posés', () => {
      beforeEach(async () => {
        await t.controller.login({ username: 'alice', password: 'mdp' }, req(), t.reply);
      });

      it('pose ws_access en httpOnly, Secure et SameSite=Strict', () => {
        expect(t.find(COOKIES.ACCESS)?.options).toMatchObject({
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          maxAge: 900,
        });
      });

      it('restreint ws_refresh au chemin de rafraîchissement', () => {
        // Le refresh token n'est ainsi pas transmis aux autres endpoints.
        expect(t.find(COOKIES.REFRESH)?.options).toMatchObject({
          httpOnly: true,
          path: REFRESH_COOKIE_PATH,
          maxAge: 604_800,
        });
      });

      it('rend ws_csrf LISIBLE par le front — le double-submit l’exige', () => {
        expect(t.find(COOKIES.CSRF)?.options).toMatchObject({ httpOnly: false, secure: true });
        expect(t.find(COOKIES.CSRF)?.value).toBe('csrf-token');
      });

      it('rend ws_role lisible, comme simple étiquette d’affichage', () => {
        expect(t.find(COOKIES.ROLE)?.options.httpOnly).toBe(false);
        expect(t.find(COOKIES.ROLE)?.value).toBe('admin');
      });
    });

    it('n’active pas Secure hors production', async () => {
      const dev = build(false);
      await dev.controller.login({ username: 'alice', password: 'mdp' }, req(), dev.reply);
      expect(dev.find(COOKIES.ACCESS)?.options.secure).toBe(false);
    });
  });

  describe('refresh', () => {
    it('refuse quand le cookie de rafraîchissement est absent', async () => {
      await expect(t.controller.refresh(req({ cookies: {} }), t.reply)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('n’EFFACE PAS les cookies quand le refresh token manque', async () => {
      // Un client sans refresh token peut être un porteur de Bearer valide :
      // effacer ws_access serait destructif.
      await t.controller.refresh(req({ cookies: {} }), t.reply).catch(() => undefined);
      expect(t.cookies).toHaveLength(0);
    });

    it('pose des cookies neufs après rotation', async () => {
      await t.controller.refresh(req({ cookies: { ws_refresh: 'ancien' } }), t.reply);
      expect(t.auth.refresh).toHaveBeenCalledWith('ancien', expect.anything());
      expect(t.find(COOKIES.ACCESS)?.value).toBe('access-jwt');
      expect(t.find(COOKIES.REFRESH)?.value).toBe('refresh-brut');
    });

    it('EFFACE les cookies quand le refresh token est invalide', async () => {
      // Sinon le client boucle sur un cookie définitivement périmé.
      t.auth.refresh.mockRejectedValue(new UnauthorizedException('Session expirée'));

      await expect(
        t.controller.refresh(req({ cookies: { ws_refresh: 'perime' } }), t.reply),
      ).rejects.toThrow(UnauthorizedException);

      expect(t.find(COOKIES.ACCESS)?.options.maxAge).toBe(0);
      expect(t.find(COOKIES.REFRESH)?.options.maxAge).toBe(0);
      expect(t.find(COOKIES.CSRF)?.options.maxAge).toBe(0);
      expect(t.find(COOKIES.ROLE)?.options.maxAge).toBe(0);
    });
  });

  describe('logout', () => {
    it('révoque la session et efface les quatre cookies', async () => {
      await t.controller.logout(USER, req(), t.reply);

      expect(t.auth.logout).toHaveBeenCalledWith('u1', 'alice', '203.0.113.10');
      expect(t.cookies.map(c => c.name).sort()).toEqual(
        [COOKIES.ACCESS, COOKIES.CSRF, COOKIES.REFRESH, COOKIES.ROLE].sort(),
      );
      expect(t.cookies.every(c => c.options.maxAge === 0)).toBe(true);
      expect(t.cookies.every(c => c.value === '')).toBe(true);
    });

    it('efface ws_refresh sur SON chemin — sinon le cookie survivrait', () => {
      return t.controller.logout(USER, req(), t.reply).then(() => {
        expect(t.find(COOKIES.REFRESH)?.options.path).toBe(REFRESH_COOKIE_PATH);
      });
    });

    it('tolère une requête sans IP', async () => {
      await t.controller.logout(USER, req({ ip: undefined }), t.reply);
      expect(t.auth.logout).toHaveBeenCalledWith('u1', 'alice', null);
    });
  });

  describe('me', () => {
    it('délègue au service, qui filtre le profil', async () => {
      await expect(t.controller.me(USER)).resolves.toEqual({ id: 'u1', username: 'alice' });
      expect(t.auth.currentUser).toHaveBeenCalledWith('u1');
    });
  });
});
