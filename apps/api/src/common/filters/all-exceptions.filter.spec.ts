import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfigService } from '../../config/app-config.service.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

interface Captured {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function hostWith(req: Record<string, unknown> = {}): { host: ArgumentsHost; sent: Captured } {
  const sent: Captured = { status: 0, body: {}, headers: {} };
  const reply = {
    status: (code: number) => {
      sent.status = code;
      return reply;
    },
    send: (body: Record<string, unknown>) => {
      sent.body = body;
      return reply;
    },
    header: (k: string, v: string) => {
      sent.headers[k] = v;
      return reply;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ id: 'req-42', method: 'POST', url: '/api/v1/test', ...req }),
    }),
  } as unknown as ArgumentsHost;

  return { host, sent };
}

function buildFilter(isProduction: boolean): AllExceptionsFilter {
  return new AllExceptionsFilter({ isProduction } as AppConfigService);
}

describe('AllExceptionsFilter', () => {
  describe('exceptions HTTP', () => {
    it('traduit une UnauthorizedException', () => {
      const { host, sent } = hostWith();
      buildFilter(false).catch(new UnauthorizedException('Identifiants incorrects'), host);

      expect(sent.status).toBe(401);
      expect(sent.body).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Identifiants incorrects',
        requestId: 'req-42',
      });
    });

    it('traduit une ForbiddenException', () => {
      const { host, sent } = hostWith();
      buildFilter(false).catch(new ForbiddenException('Droits insuffisants'), host);
      expect(sent.status).toBe(403);
    });

    it('agrège une liste de messages de validation', () => {
      const { host, sent } = hostWith();
      buildFilter(false).catch(
        new BadRequestException({ message: ['username requis', 'password requis'] }),
        host,
      );
      expect(sent.body.message).toBe('username requis, password requis');
    });

    it('accepte une réponse d’exception sous forme de chaîne', () => {
      const { host, sent } = hostWith();
      buildFilter(false).catch(new HttpException('Message brut', HttpStatus.CONFLICT), host);
      expect(sent.status).toBe(409);
      expect(sent.body.message).toBe('Message brut');
    });

    it('déduit un libellé quand la réponse n’en porte pas', () => {
      const { host, sent } = hostWith();
      buildFilter(false).catch(new HttpException({ foo: 'bar' }, HttpStatus.CONFLICT), host);
      expect(sent.body.error).toBe('CONFLICT');
    });

    it('promeut retryAfter en en-tête Retry-After', () => {
      // Dans le corps seul, les clients HTTP l'ignorent.
      const { host, sent } = hostWith();
      buildFilter(false).catch(
        new HttpException(
          { statusCode: 429, error: 'Trop de requêtes', message: 'Patientez', retryAfter: 120 },
          429,
        ),
        host,
      );
      expect(sent.headers['Retry-After']).toBe('120');
    });
  });

  describe('erreurs de validation Zod', () => {
    it('n’expose que les chemins de champs, jamais les valeurs reçues', () => {
      // Une valeur rejetée peut être un mot de passe : la renvoyer serait une fuite.
      const schema = z.object({ username: z.string(), password: z.string() });
      const result = schema.safeParse({ username: 123, password: 'tres-secret' });
      const { host, sent } = hostWith();

      buildFilter(false).catch(result.error, host);

      expect(sent.status).toBe(400);
      expect(String(sent.body.message)).toContain('username');
      expect(String(sent.body.message)).not.toContain('tres-secret');
    });
  });

  describe('erreurs internes — aucune fuite', () => {
    it('renvoie un message générique pour une Error nue', () => {
      const { host, sent } = hostWith();
      buildFilter(true).catch(new Error('ER_ACCESS_DENIED: mot de passe MariaDB refusé'), host);

      expect(sent.status).toBe(500);
      expect(sent.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Une erreur interne est survenue',
        requestId: 'req-42',
      });
    });

    it('ne renvoie JAMAIS de stack trace', () => {
      const err = new Error('panne');
      err.stack = 'Error: panne\n    at /srv/websentry/apps/api/dist/db.js:42:15';
      const { host, sent } = hostWith();

      buildFilter(true).catch(err, host);
      expect(JSON.stringify(sent.body)).not.toContain('/srv/websentry');
      expect(JSON.stringify(sent.body)).not.toContain('at ');
    });

    it('produit la MÊME réponse en développement qu’en production', () => {
      // Une divergence laisserait passer en production une fuite jamais vue en local.
      const err = new Error('détail interne sensible');
      const dev = hostWith();
      const prod = hostWith();

      buildFilter(false).catch(err, dev.host);
      buildFilter(true).catch(err, prod.host);

      expect(dev.sent.body).toEqual(prod.sent.body);
    });

    it.each([
      ['une chaîne levée', 'boom'],
      ['un objet nu', { code: 'ER_DUP_ENTRY' }],
      ['null', null],
      ['undefined', undefined],
    ])('neutralise %s', (_label, thrown) => {
      const { host, sent } = hostWith();
      buildFilter(true).catch(thrown, host);
      expect(sent.status).toBe(500);
      expect(sent.body.message).toBe('Une erreur interne est survenue');
    });
  });

  describe('corrélation', () => {
    it('reprend l’identifiant de requête', () => {
      const { host, sent } = hostWith({ id: 'abc-123' });
      buildFilter(false).catch(new Error('x'), host);
      expect(sent.body.requestId).toBe('abc-123');
    });

    it('retombe sur "unknown" quand la requête n’en porte pas', () => {
      const { host, sent } = hostWith({ id: undefined });
      buildFilter(false).catch(new Error('x'), host);
      expect(sent.body.requestId).toBe('unknown');
    });
  });

  it('expose l’environnement courant pour les tests de configuration', () => {
    expect(buildFilter(true).isProduction).toBe(true);
    expect(buildFilter(false).isProduction).toBe(false);
  });
});
