import { describe, expect, it } from 'vitest';
import { isBlockedIp, stripBrackets } from './ip-rules.js';

/**
 * Blocklist SSRF — chaque plage est vérifiée avec une adresse RÉELLE de la plage,
 * pas seulement avec sa borne. Une regex trop permissive passerait un test sur
 * `10.0.0.0` tout en laissant filer `10.255.3.7`.
 */
describe('isBlockedIp', () => {
  describe('IPv4 — plages privées et réservées', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['127.255.255.254', 'loopback (haut de plage)'],
      ['0.0.0.0', 'this network'],
      ['0.1.2.3', 'this network'],
      ['10.0.0.1', 'RFC 1918 classe A'],
      ['10.255.3.7', 'RFC 1918 classe A (milieu)'],
      ['172.16.0.1', 'RFC 1918 classe B (borne basse)'],
      ['172.31.255.254', 'RFC 1918 classe B (borne haute)'],
      ['172.20.10.5', 'RFC 1918 classe B (milieu)'],
      ['192.168.1.1', 'RFC 1918 classe C'],
      ['169.254.169.254', 'métadonnées cloud — cible SSRF classique'],
      ['100.64.0.1', 'CGNAT RFC 6598 (borne basse)'],
      ['100.127.255.254', 'CGNAT RFC 6598 (borne haute)'],
      ['192.0.0.1', 'IETF protocol assignments'],
      ['192.0.2.5', 'TEST-NET-1'],
      ['198.18.0.1', 'benchmarking'],
      ['198.19.255.1', 'benchmarking (haut)'],
      ['198.51.100.7', 'TEST-NET-2'],
      ['203.0.113.9', 'TEST-NET-3'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.250', 'multicast (SSDP)'],
      ['240.0.0.1', 'réservé'],
      ['255.255.255.255', 'broadcast'],
    ])('bloque %s (%s)', ip => {
      expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
      ['8.8.8.8', 'DNS public Google'],
      ['1.1.1.1', 'DNS public Cloudflare'],
      ['93.184.216.34', 'hôte public quelconque'],
      ['172.15.255.255', 'juste SOUS la plage RFC 1918 classe B'],
      ['172.32.0.1', 'juste AU-DESSUS de la plage RFC 1918 classe B'],
      ['100.63.255.255', 'juste SOUS la plage CGNAT'],
      ['100.128.0.1', 'juste AU-DESSUS de la plage CGNAT'],
      ['11.0.0.1', 'adjacent à 10.0.0.0/8, mais public'],
      ['192.167.255.255', 'adjacent à 192.168.0.0/16, mais public'],
    ])('autorise %s (%s)', ip => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  });

  describe('IPv6 — plages privées et réservées', () => {
    it.each([
      ['::', 'adresse non spécifiée'],
      ['::1', 'loopback'],
      ['fe80::1', 'link-local'],
      ['fc00::1', 'ULA'],
      ['fd12:3456::1', 'ULA'],
      ['ff02::1', 'multicast'],
    ])('bloque %s (%s)', ip => {
      expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
      ['2001:4860:4860::8888', 'DNS public Google IPv6'],
      ['2606:4700:4700::1111', 'DNS public Cloudflare IPv6'],
    ])('autorise %s (%s)', ip => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  });

  describe('IPv4 mappé en IPv6 — contournement classique', () => {
    it('bloque la forme pointée ::ffff:127.0.0.1', () => {
      expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('bloque la forme hexadécimale ::ffff:7f00:1 (même adresse, écriture différente)', () => {
      expect(isBlockedIp('::ffff:7f00:1')).toBe(true);
    });

    it('bloque ::ffff:a9fe:a9fe (169.254.169.254 en hexadécimal)', () => {
      expect(isBlockedIp('::ffff:a9fe:a9fe')).toBe(true);
    });

    it('autorise une IPv4 publique mappée', () => {
      expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    });

    it('autorise la forme hexadécimale d’une IPv4 publique', () => {
      expect(isBlockedIp('::ffff:0808:0808')).toBe(false);
    });

    it('bloque une forme mappée à un seul groupe illisible', () => {
      // Ni pointée, ni deux groupes : la forme retombe sur le refus par défaut
      // plutôt que d'être interprétée au jugé.
      expect(isBlockedIp('::ffff:zzzz')).toBe(true);
    });

    it('bloque deux groupes de la bonne FORME mais non hexadécimaux', () => {
      // La découpe réussit, la conversion échoue : sans le contrôle NaN, on
      // fabriquerait une IPv4 fantaisiste à partir de NaN.
      expect(isBlockedIp('::ffff:zzzz:wwww')).toBe(true);
    });
  });

  describe('NAT64 (64:ff9b::/96)', () => {
    it('bloque la forme pointée vers une IPv4 privée', () => {
      expect(isBlockedIp('64:ff9b::127.0.0.1')).toBe(true);
    });

    it('bloque la forme hexadécimale vers une IPv4 privée', () => {
      expect(isBlockedIp('64:ff9b::7f00:1')).toBe(true);
    });

    it('autorise la forme pointée vers une IPv4 publique', () => {
      expect(isBlockedIp('64:ff9b::8.8.8.8')).toBe(false);
    });

    it('autorise la forme hexadécimale vers une IPv4 publique', () => {
      expect(isBlockedIp('64:ff9b::0808:0808')).toBe(false);
    });

    it('bloque une forme inconnue derrière le préfixe NAT64', () => {
      expect(isBlockedIp('64:ff9b::zzz')).toBe(true);
    });
  });

  describe('refus par défaut', () => {
    it.each([
      ['pas-une-ip', 'chaîne arbitraire'],
      ['', 'chaîne vide'],
      ['999.999.999.999', 'octets hors bornes'],
      ['localhost', 'nom d’hôte, pas une IP'],
      ['0x7f000001', 'notation hexadécimale d’IPv4'],
      ['2130706433', 'notation décimale d’IPv4'],
      ['127.1', 'forme abrégée d’IPv4'],
    ])('bloque %s (%s)', value => {
      expect(isBlockedIp(value)).toBe(true);
    });

    it('normalise la casse et les espaces avant de décider', () => {
      expect(isBlockedIp('  ::FFFF:127.0.0.1  ')).toBe(true);
      expect(isBlockedIp('FE80::1')).toBe(true);
    });
  });
});

describe('stripBrackets', () => {
  it('retire les crochets d’un hôte IPv6', () => {
    expect(stripBrackets('[::1]')).toBe('::1');
  });

  it('laisse intact un hôte sans crochets', () => {
    expect(stripBrackets('example.com')).toBe('example.com');
  });

  it('laisse intact un hôte aux crochets déséquilibrés', () => {
    expect(stripBrackets('[::1')).toBe('[::1');
    expect(stripBrackets('::1]')).toBe('::1]');
  });
});
