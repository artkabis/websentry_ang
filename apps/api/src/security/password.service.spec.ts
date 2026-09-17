import { describe, expect, it, beforeAll } from 'vitest';
import { PasswordService } from './password.service.js';

/**
 * scrypt est volontairement coûteux (~100 ms par dérivation) : chaque test qui
 * hache paie ce prix. Les hash réutilisables sont donc calculés une seule fois.
 */
describe('PasswordService', () => {
  const service = new PasswordService();
  let hash: string;

  beforeAll(async () => {
    hash = await service.hash('MotDePasse!2026');
  }, 30_000);

  describe('hash', () => {
    it('produit le format "<sel>:<empreinte>"', () => {
      const [salt, digest] = hash.split(':');
      expect(salt).toMatch(/^[0-9a-f]{32}$/); // 16 octets de sel
      expect(digest).toMatch(/^[0-9a-f]{128}$/); // 64 octets de clé dérivée
    });

    it('produit un hash DIFFÉRENT à chaque appel pour le même mot de passe', async () => {
      // Le sel est aléatoire : deux comptes partageant un mot de passe n'ont pas
      // le même hash, ce qui rend les tables arc-en-ciel inopérantes.
      const other = await service.hash('MotDePasse!2026');
      expect(other).not.toBe(hash);
    }, 30_000);
  });

  describe('verify', () => {
    it('accepte le mot de passe correct', async () => {
      await expect(service.verify('MotDePasse!2026', hash)).resolves.toBe(true);
    }, 30_000);

    it('refuse un mot de passe incorrect', async () => {
      await expect(service.verify('MotDePasse!2027', hash)).resolves.toBe(false);
    }, 30_000);

    it('refuse un mot de passe vide', async () => {
      await expect(service.verify('', hash)).resolves.toBe(false);
    }, 30_000);

    it.each([
      ['', 'chaîne vide'],
      ['sans-separateur', 'aucun caractère deux-points'],
      [':', 'sel et empreinte vides'],
      ['sel:', 'empreinte vide'],
      [':empreinte', 'sel vide'],
      ['sel:pas-de-l-hexadecimal', 'empreinte non hexadécimale'],
    ])(
      'refuse sans lever face à un hash stocké malformé (%s)',
      async stored => {
        await expect(service.verify('peu importe', stored)).resolves.toBe(false);
      },
      30_000,
    );

    it('refuse sans lever si une valeur NON TEXTUELLE atteint la vérification', async () => {
      // Les types l'interdisent, mais une charge utile JSON mal validée pourrait
      // faire parvenir un objet jusqu'ici : scrypt lèverait, et une exception
      // non rattrapée transformerait un échec d'authentification en 500.
      await expect(
        service.verify({ toString: () => 'x' } as unknown as string, hash),
      ).resolves.toBe(false);
    }, 30_000);

    it('refuse quand l’empreinte stockée n’a pas la bonne longueur', async () => {
      // Un hash tronqué ne doit pas être comparé partiellement : `timingSafeEqual`
      // lèverait sur des longueurs différentes, d'où le contrôle préalable.
      await expect(service.verify('MotDePasse!2026', 'abcd:00ff')).resolves.toBe(false);
    }, 30_000);
  });

  describe('timingSafeStringEqual', () => {
    it('reconnaît deux chaînes identiques', () => {
      expect(service.timingSafeStringEqual('secret', 'secret')).toBe(true);
    });

    it('distingue deux chaînes différentes', () => {
      expect(service.timingSafeStringEqual('secret', 'secrei')).toBe(false);
    });

    it('compare sans lever des chaînes de longueurs différentes', () => {
      // Le condensé SHA-256 préalable égalise les longueurs — sans lui,
      // `timingSafeEqual` lèverait et fuiterait déjà l'information de longueur.
      expect(service.timingSafeStringEqual('a', 'chaîne beaucoup plus longue')).toBe(false);
    });

    it('reconnaît deux chaînes vides', () => {
      expect(service.timingSafeStringEqual('', '')).toBe(true);
    });
  });
});
