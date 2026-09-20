import { describe, expect, it } from 'vitest';
import { locateFromText, truncateSource } from './locate.js';

describe('locateFromText', () => {
  it('cible un texte court dans son intégralité', () => {
    expect(locateFromText('Cliquez ici')).toEqual({ text: 'Cliquez ici' });
  });

  it('normalise les espaces', () => {
    expect(locateFromText('  Cliquez\n  ici  ')).toEqual({ text: 'Cliquez ici' });
  });

  it('cible une PLAGE début…fin pour un texte long', () => {
    // Un passage de quarante mots traversant plusieurs nœuds ne serait jamais
    // retrouvé tel quel par le navigateur.
    const long = 'un deux trois quatre cinq six sept huit neuf dix';
    expect(locateFromText(long)).toEqual({
      text: 'un deux trois quatre cinq',
      textEnd: 'huit neuf dix',
    });
  });

  it('n’ancre pas un texte trop court', () => {
    expect(locateFromText('ok')).toBeUndefined();
    expect(locateFromText('')).toBeUndefined();
    expect(locateFromText(null)).toBeUndefined();
  });

  it('ancre exactement à la limite des huit mots', () => {
    const eight = 'un deux trois quatre cinq six sept huit';
    expect(locateFromText(eight)).toEqual({ text: eight });
  });
});

describe('truncateSource', () => {
  it('normalise et conserve un extrait court', () => {
    expect(truncateSource('<p>\n  a  </p>')).toBe('<p> a </p>');
  });

  it('tronque au-delà de la borne', () => {
    const result = truncateSource(`<p>${'x'.repeat(500)}</p>`, 50);
    expect(result).toHaveLength(51);
    expect(result?.endsWith('…')).toBe(true);
  });

  it('rend undefined pour du vide', () => {
    expect(truncateSource('   ')).toBeUndefined();
    expect(truncateSource(null)).toBeUndefined();
  });
});
