import { describe, expect, it } from 'vitest';
import { AuditEntrySchema, AuditListResponseSchema, AuditQuerySchema } from './audit.schema';

function entree(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    actorId: 'u-1',
    actorName: 'alice',
    action: 'user.create',
    targetId: 'u-2',
    targetType: 'user',
    details: { username: 'bob' },
    ipAddress: '203.0.113.7',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('AuditEntrySchema', () => {
  it('accepte une entrée complète', () => {
    expect(AuditEntrySchema.parse(entree())).toMatchObject({ action: 'user.create' });
  });

  it('accepte une action système, sans acteur ni cible', () => {
    // La rétention et les tâches planifiées écrivent sans personne derrière.
    expect(
      AuditEntrySchema.parse(
        entree({ actorId: null, actorName: null, targetId: null, targetType: null, details: null }),
      ).actorId,
    ).toBeNull();
  });

  it('REFUSE une clé surnuméraire', () => {
    expect(() => AuditEntrySchema.parse({ ...entree(), motDePasse: 'secret' })).toThrow();
  });

  it('accepte un détail de forme quelconque', () => {
    // L'imposer obligerait à faire évoluer ce schéma à chaque nouvelle trace.
    expect(
      AuditEntrySchema.parse(entree({ details: { gammes: ['a'], profondeur: 3, actif: true } }))
        .details,
    ).toEqual({ gammes: ['a'], profondeur: 3, actif: true });
  });

  it('REFUSE un horodatage qui n’est pas une date ISO', () => {
    expect(() => AuditEntrySchema.parse(entree({ createdAt: '01/01/2026' }))).toThrow();
  });
});

describe('AuditListResponseSchema', () => {
  it('exige le total, que la pagination ne donne pas', () => {
    expect(() => AuditListResponseSchema.parse({ entries: [] })).toThrow();
    expect(AuditListResponseSchema.parse({ entries: [entree()], total: 1 }).total).toBe(1);
  });
});

describe('AuditQuerySchema', () => {
  it('pose des bornes par défaut', () => {
    expect(AuditQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('COERCE les nombres, qui arrivent en texte depuis l’URL', () => {
    expect(AuditQuerySchema.parse({ limit: '25', offset: '50' })).toMatchObject({
      limit: 25,
      offset: 50,
    });
  });

  it('BORNE la pagination pour empêcher l’extraction massive', () => {
    expect(() => AuditQuerySchema.parse({ limit: '5000' })).toThrow();
    expect(() => AuditQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => AuditQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  it('accepte des bornes de date au jour près', () => {
    expect(AuditQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31' })).toMatchObject({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('REFUSE une date mal formée plutôt que de l’ignorer', () => {
    // L'ignorer afficherait un résultat non filtré sous un filtre affiché.
    expect(() => AuditQuerySchema.parse({ from: '01/2026' })).toThrow();
  });

  it('REFUSE une clé surnuméraire', () => {
    expect(() => AuditQuerySchema.parse({ tri: 'id' })).toThrow();
  });
});
