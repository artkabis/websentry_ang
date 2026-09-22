import { describe, expect, it } from 'vitest';
import { etatGlobal, SupervisionSchema, type EtatComposant } from './supervision.schema';

function releve(over: Record<string, unknown> = {}) {
  return {
    etat: 'ok',
    releveA: '2026-01-01T00:00:00.000Z',
    instance: { version: '2.0.0', environnement: 'production', uptimeSec: 3600 },
    base: { etat: 'ok', message: 'Connectée.', active: true, latenceMs: 3 },
    poolAnalyse: {
      etat: 'ok',
      message: 'Pool démarré.',
      active: true,
      demarre: true,
      enEchec: false,
      threadsMax: 4,
    },
    retention: { etat: 'ok', message: 'Passage réussi.', active: true, dernierPassage: null },
    volumetrie: { scans24h: 12, scans7j: 80, comptesActifs: 5, retoursOuverts: 2 },
    ...over,
  };
}

describe('SupervisionSchema', () => {
  it('accepte un relevé complet', () => {
    expect(SupervisionSchema.parse(releve()).etat).toBe('ok');
  });

  it('accepte une volumétrie ABSENTE quand la base est injoignable', () => {
    // On ne devine pas des chiffres : mieux vaut ne rien annoncer qu'annoncer
    // des zéros qui passeraient pour une instance au repos.
    expect(SupervisionSchema.parse(releve({ volumetrie: null })).volumetrie).toBeNull();
  });

  it('accepte une latence nulle quand la base est absente', () => {
    const sansBase = releve({
      base: { etat: 'panne', message: 'Base désactivée.', active: false, latenceMs: null },
    });
    expect(SupervisionSchema.parse(sansBase).base.latenceMs).toBeNull();
  });

  it('REFUSE une clé surnuméraire — la surface est explicite', () => {
    // Cette réponse décrit l'INFRASTRUCTURE : un champ ajouté par mégarde y
    // serait un renseignement offert.
    expect(() => SupervisionSchema.parse({ ...releve(), hote: 'srv-01' })).toThrow();
    expect(() =>
      SupervisionSchema.parse(releve({ base: { ...releve().base, motDePasse: 'x' } })),
    ).toThrow();
  });

  it('REFUSE un état inventé', () => {
    expect(() => SupervisionSchema.parse(releve({ etat: 'bof' }))).toThrow();
  });

  it('accepte un dernier passage de rétention', () => {
    const avecPassage = releve({
      retention: {
        etat: 'ok',
        message: 'Passage réussi.',
        active: true,
        dernierPassage: {
          termineA: '2026-01-01T03:00:00.000Z',
          compresses: 120,
          purges: 30,
          restants: 4,
          dureeMs: 8200,
          reussi: true,
        },
      },
    });
    expect(SupervisionSchema.parse(avecPassage).retention.dernierPassage?.compresses).toBe(120);
  });

  it('REFUSE des compteurs négatifs', () => {
    expect(() =>
      SupervisionSchema.parse(releve({ volumetrie: { ...releve().volumetrie, scans24h: -1 } })),
    ).toThrow();
  });
});

describe('etatGlobal', () => {
  it('rend « ok » sur un ensemble sain', () => {
    expect(etatGlobal(['ok', 'ok', 'ok'])).toBe('ok');
  });

  it('rend « ok » sur un ensemble VIDE', () => {
    // Le cas ne se produit pas aujourd'hui, mais un réduit sans valeur initiale
    // échouerait ; l'invariant est explicite.
    expect(etatGlobal([])).toBe('ok');
  });

  it('LE PIRE l’emporte, et non la majorité', () => {
    // Annoncer « tout va bien » parce que deux composants sur trois marchent
    // est exactement ce qui fait ignorer un tableau de bord.
    expect(etatGlobal(['ok', 'ok', 'degrade'])).toBe('degrade');
    expect(etatGlobal(['ok', 'ok', 'panne'])).toBe('panne');
    expect(etatGlobal(['degrade', 'degrade', 'panne'])).toBe('panne');
  });

  it('ne dépend pas de l’ordre', () => {
    const etats: EtatComposant[] = ['panne', 'ok', 'degrade'];
    expect(etatGlobal(etats)).toBe(etatGlobal([...etats].reverse()));
  });

  it('classe « panne » au-dessus de « degrade »', () => {
    expect(etatGlobal(['degrade', 'panne'])).toBe('panne');
    expect(etatGlobal(['panne', 'degrade'])).toBe('panne');
  });
});
