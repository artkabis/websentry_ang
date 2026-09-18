import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE, readCookie, ROLE_COOKIE, SAFE_METHODS } from './csrf';

describe('readCookie', () => {
  it('lit un cookie unique', () => {
    expect(readCookie('ws_csrf', 'ws_csrf=abc123')).toBe('abc123');
  });

  it('lit un cookie au milieu d’une liste', () => {
    expect(readCookie('ws_csrf', 'ws_role=admin; ws_csrf=abc123; autre=x')).toBe('abc123');
  });

  it('décode une valeur encodée en pourcent', () => {
    expect(readCookie('ws_csrf', 'ws_csrf=a%2Bb%3Dc')).toBe('a+b=c');
  });

  it('retourne null quand le cookie est absent', () => {
    expect(readCookie('ws_csrf', 'ws_role=admin')).toBeNull();
  });

  it('retourne null sur une chaîne vide', () => {
    expect(readCookie('ws_csrf', '')).toBeNull();
  });

  it('retourne une chaîne vide pour un cookie sans valeur', () => {
    expect(readCookie('ws_csrf', 'ws_csrf=')).toBe('');
  });

  it('ne confond pas un cookie dont le nom est un PRÉFIXE d’un autre', () => {
    // `ws_csrf_autre` ne doit jamais être lu à la place de `ws_csrf`.
    expect(readCookie('ws_csrf', 'ws_csrf_autre=piege; ws_csrf=bon')).toBe('bon');
  });

  it('tolère les espaces autour des séparateurs', () => {
    expect(readCookie('ws_csrf', '  ws_csrf=abc  ;  autre=x')).toBe('abc');
  });
});

describe('constantes', () => {
  it('nomme les cookies comme l’API les pose', () => {
    expect(CSRF_COOKIE).toBe('ws_csrf');
    expect(ROLE_COOKIE).toBe('ws_role');
  });

  it('énumère les méthodes sans effet de bord', () => {
    expect(SAFE_METHODS).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });
});
