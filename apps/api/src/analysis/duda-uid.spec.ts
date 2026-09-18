import { describe, expect, it } from 'vitest';
import { extractEpj, extractGamme, parseExternalUid } from './duda-uid.js';

const uid = (value: string) => `<script>window.Parameters = { ExternalUid: '${value}' };</script>`;

describe('parseExternalUid', () => {
  it('lit la gamme et l’EPJ', () => {
    expect(parseExternalUid(uid('PREMIUM|ABC-123'))).toEqual({ gamme: 'premium', epj: 'ABC-123' });
  });

  it('accepte les guillemets doubles', () => {
    const html = '<script>window.Parameters = { ExternalUid: "PREMIUM|ABC" };</script>';
    expect(parseExternalUid(html).gamme).toBe('premium');
  });

  it('tolère les espaces autour du séparateur', () => {
    expect(parseExternalUid(uid('  PREMIUM  |  ABC  '))).toEqual({
      gamme: 'premium',
      epj: 'ABC',
    });
  });

  it('NORMALISE la gamme comme le fait le module des profils', () => {
    // Sans normalisation commune, « START Plus! » désignerait un profil côté
    // analyse et un autre côté réglages.
    expect(parseExternalUid(uid('START Plus!|X')).gamme).toBe('startplus');
  });

  it('rend null quand le champ est absent', () => {
    expect(parseExternalUid('<html></html>')).toEqual({ gamme: null, epj: null });
  });

  it('rend null sur le marqueur « non renseigné » de Duda', () => {
    expect(parseExternalUid(uid('—|—'))).toEqual({ gamme: null, epj: null });
  });

  it('rend null pour la gamme « default »', () => {
    // `default` n'est pas une gamme mais le nom du profil de repli : la rendre
    // ferait croire à une détection réussie.
    expect(parseExternalUid(uid('default|ABC')).gamme).toBeNull();
  });

  it('accepte une gamme sans EPJ', () => {
    expect(parseExternalUid(uid('premium'))).toEqual({ gamme: 'premium', epj: null });
  });

  it('BORNE la valeur lue', () => {
    // Une page hostile pourrait y placer un mégaoctet : la regex s'arrête avant.
    expect(parseExternalUid(uid('x'.repeat(500))).gamme).toBeNull();
  });

  it('expose des raccourcis cohérents avec l’analyse complète', () => {
    const html = uid('PREMIUM|ABC');
    expect(extractGamme(html)).toBe('premium');
    expect(extractEpj(html)).toBe('ABC');
  });
});
