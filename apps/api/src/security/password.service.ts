import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Hachage de mot de passe (scrypt) et comparaisons à temps constant.
 *
 * Paramètres alignés sur la v1 — un changement invaliderait les hash existants
 * en base, ce qui déconnecterait tous les comptes migrés.
 */

/** Facteur de coût CPU+mémoire (2^14) — plancher recommandé par l'OWASP, ~16 Mo. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

@Injectable()
export class PasswordService {
  /**
   * Hache un mot de passe. Format stocké : `<salt_hex>:<hash_hex>`.
   *
   * Asynchrone (contrairement à la v1 qui utilisait `scryptSync`) : scrypt occupe
   * ~100 ms de CPU, ce qui bloquerait la boucle d'événements de Fastify à chaque
   * tentative de connexion et offrirait un levier de déni de service trivial.
   */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, SCRYPT_KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return `${salt}:${derived.toString('hex')}`;
  }

  /**
   * Vérifie un mot de passe contre un hash stocké.
   *
   * Comparaison en temps constant : une comparaison naïve fuiterait, par son
   * temps d'exécution, le nombre d'octets corrects en tête de hash.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    try {
      const [salt, hashHex] = stored.split(':');
      if (!salt || !hashHex) return false;

      const storedBuf = Buffer.from(hashHex, 'hex');
      const derivedBuf = await scrypt(password, salt, SCRYPT_KEY_LEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      });
      if (storedBuf.length !== derivedBuf.length) return false;
      return timingSafeEqual(storedBuf, derivedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Compare deux chaînes en temps constant.
   *
   * Les deux entrées sont d'abord condensées en SHA-256 : `timingSafeEqual` exige
   * des tampons de même longueur, et passer la longueur brute fuiterait déjà une
   * information sur le secret.
   */
  timingSafeStringEqual(a: string, b: string): boolean {
    const bufA = createHash('sha256').update(a).digest();
    const bufB = createHash('sha256').update(b).digest();
    return timingSafeEqual(bufA, bufB);
  }
}
