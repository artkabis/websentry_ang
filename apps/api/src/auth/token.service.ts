import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service.js';
import type { AuthUser } from '../common/types.js';

/** Charge utile signée dans l'access token. */
export interface AccessTokenPayload {
  sub: string;
  username: string;
  rank: number;
  /** Version de jeton — comparée à `users.token_version` pour révoquer. */
  version: number;
}

/**
 * Signature et vérification des access tokens.
 *
 * L'algorithme est ÉPINGLÉ à HS256 côté signature ET côté vérification : sans cette
 * contrainte, un jeton forgé avec `alg: none` (ou une confusion RS256/HS256) serait
 * accepté. La présence de `exp` est exigée explicitement — `jsonwebtoken` accepte un
 * jeton sans expiration, qui serait alors éternel.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /** Signe un access token. `ttlSeconds` permet de forger un jeton expiré en test. */
  async sign(payload: AccessTokenPayload, ttlSeconds?: number): Promise<string> {
    return this.jwt.signAsync(
      { ...payload },
      {
        algorithm: 'HS256',
        secret: this.config.jwtSecret,
        expiresIn: ttlSeconds ?? this.config.accessTokenTtl,
      },
    );
  }

  /**
   * Vérifie un access token.
   *
   * @returns l'identité si le jeton est valide et non expiré, `null` sinon —
   *          jamais d'exception : un jeton invalide est un cas nominal, pas une panne.
   */
  async verify(token: string): Promise<AuthUser | null> {
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        algorithms: ['HS256'],
        secret: this.config.jwtSecret,
      });

      // `exp` OBLIGATOIRE : un jeton sans expiration ne doit jamais être honoré.
      if (typeof payload.exp !== 'number') return null;
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
      if (typeof payload.rank !== 'number') return null;

      return {
        sub: payload.sub,
        username: typeof payload.username === 'string' ? payload.username : payload.sub,
        rank: payload.rank,
        version: typeof payload.version === 'number' ? payload.version : -1,
      };
    } catch {
      return null;
    }
  }
}
