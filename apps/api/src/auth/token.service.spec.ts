import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { AppConfigService } from '../config/app-config.service.js';
import { TokenService } from './token.service.js';

const SECRET = 'un-secret-de-test-suffisamment-long-pour-hs256';
const OTHER_SECRET = 'un-AUTRE-secret-de-test-tout-aussi-long-hs256';

/** Double de configuration : évite de dépendre de `process.env` dans les tests. */
function configStub(secret = SECRET, accessTtl = 900): AppConfigService {
  return { jwtSecret: secret, accessTokenTtl: accessTtl } as AppConfigService;
}

async function buildTokenService(config: AppConfigService): Promise<TokenService> {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: config.jwtSecret })],
    providers: [TokenService, { provide: AppConfigService, useValue: config }],
  }).compile();
  return moduleRef.get(TokenService);
}

describe('TokenService', () => {
  let service: TokenService;

  beforeEach(async () => {
    service = await buildTokenService(configStub());
  });

  describe('sign puis verify', () => {
    it('restitue l’identité signée', async () => {
      const token = await service.sign({
        sub: 'user-1',
        username: 'alice',
        rank: 50,
        version: 3,
      });

      await expect(service.verify(token)).resolves.toEqual({
        sub: 'user-1',
        username: 'alice',
        rank: 50,
        version: 3,
      });
    });

    it('accepte un TTL explicite', async () => {
      const token = await service.sign(
        { sub: 'user-1', username: 'alice', rank: 10, version: 0 },
        3600,
      );
      await expect(service.verify(token)).resolves.not.toBeNull();
    });
  });

  describe('rejets', () => {
    it('refuse un jeton signé avec un AUTRE secret', async () => {
      const foreign = await buildTokenService(configStub(OTHER_SECRET));
      const token = await foreign.sign({
        sub: 'attaquant',
        username: 'mallory',
        rank: 100,
        version: 0,
      });

      await expect(service.verify(token)).resolves.toBeNull();
    });

    it('refuse un jeton expiré', async () => {
      // TTL négatif : le jeton naît déjà périmé.
      const token = await service.sign(
        { sub: 'user-1', username: 'alice', rank: 50, version: 0 },
        -60,
      );
      await expect(service.verify(token)).resolves.toBeNull();
    });

    it('refuse un jeton SANS claim exp (jeton éternel)', async () => {
      // Signé hors du service pour omettre `expiresIn` — un tel jeton, accepté,
      // ne pourrait jamais être révoqué par le temps.
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const eternal = raw.sign({ sub: 'user-1', username: 'alice', rank: 50, version: 0 });

      await expect(service.verify(eternal)).resolves.toBeNull();
    });

    it('refuse un jeton forgé avec alg:none', async () => {
      // Confusion d'algorithme : en-tête `{"alg":"none"}`, signature vide.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'attaquant',
          username: 'mallory',
          rank: 100,
          version: 0,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      await expect(service.verify(`${header}.${payload}.`)).resolves.toBeNull();
    });

    it.each([
      ['', 'chaîne vide'],
      ['pas.un.jwt', 'segments non décodables'],
      ['aaa', 'un seul segment'],
      ['a.b', 'deux segments'],
    ])('refuse un jeton malformé (%s)', async token => {
      await expect(service.verify(token)).resolves.toBeNull();
    });

    it('refuse un jeton dont la charge utile n’a pas de sub', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const token = raw.sign({ username: 'alice', rank: 50, version: 0 }, { expiresIn: 600 });

      await expect(service.verify(token)).resolves.toBeNull();
    });

    it('refuse un jeton dont le sub est vide', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const token = raw.sign(
        { sub: '', username: 'alice', rank: 50, version: 0 },
        { expiresIn: 600 },
      );

      await expect(service.verify(token)).resolves.toBeNull();
    });

    it('refuse un jeton SANS rang — un rang absent vaudrait 0 par défaut', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const token = raw.sign({ sub: 'user-1', username: 'alice' }, { expiresIn: 600 });

      await expect(service.verify(token)).resolves.toBeNull();
    });
  });

  describe('valeurs de repli', () => {
    it('reprend le sub comme nom d’utilisateur quand username manque', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const token = raw.sign({ sub: 'user-9', rank: 10, version: 2 }, { expiresIn: 600 });

      await expect(service.verify(token)).resolves.toMatchObject({
        sub: 'user-9',
        username: 'user-9',
      });
    });

    it('retourne la version -1 quand le claim version est absent', async () => {
      // -1 signale un jeton hérité, sans confrontation possible à token_version.
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({ secret: SECRET })],
      }).compile();
      const raw = moduleRef.get(JwtService);
      const token = raw.sign({ sub: 'user-9', username: 'bob', rank: 10 }, { expiresIn: 600 });

      await expect(service.verify(token)).resolves.toMatchObject({ version: -1 });
    });
  });
});
