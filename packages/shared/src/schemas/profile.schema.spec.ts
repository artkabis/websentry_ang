import { describe, expect, it } from 'vitest';
import { defaultAnalysisSettings } from './settings.schema.js';
import {
  DEFAULT_PROFILE,
  GammeParamSchema,
  GammeSchema,
  ImportProfileSchema,
  PROFILE_EXPORT_VERSION,
  ProfileExportSchema,
  SaveProfileSchema,
  normalizeGamme,
} from './profile.schema.js';

describe('normalizeGamme', () => {
  it.each([
    ['PREMIUM', 'premium'],
    ['START Plus!', 'startplus'],
    ['Performance-V2', 'performance-v2'],
    ['  premium  ', 'premium'],
    ['pré-mium', 'pr-mium'],
  ])('normalise %s en %s', (raw, expected) => {
    expect(normalizeGamme(raw)).toBe(expected);
  });

  it('tronque à 50 caractères', () => {
    expect(normalizeGamme('a'.repeat(200))).toHaveLength(50);
  });

  it.each([
    ['../../etc/passwd', 'etcpasswd'],
    ['..%2f..%2fetc', '2f2fetc'],
    ['profil/../autre', 'profilautre'],
    ['C:\\Windows', 'cwindows'],
  ])('neutralise une tentative de traversée de chemin : %s', (raw, expected) => {
    // Le stockage est en base, donc la gamme ne construit plus de chemin ; la
    // normalisation reste néanmoins la garantie que rien d'exotique ne circule
    // jusqu'à un nom de fichier d'export.
    expect(normalizeGamme(raw)).toBe(expected);
  });

  it('rend une chaîne vide quand rien d’exploitable ne subsiste', () => {
    // Le service refuse ce cas : un profil sans identifiant serait introuvable.
    expect(normalizeGamme('!!!')).toBe('');
    expect(normalizeGamme('...')).toBe('');
  });

  it('produit toujours une valeur acceptée par GammeSchema, sauf si vide', () => {
    for (const raw of ['PREMIUM', 'START Plus!', 'Performance_V2', 'é@#ab']) {
      const normalized = normalizeGamme(raw);
      if (normalized.length > 0) {
        expect(GammeSchema.safeParse(normalized).success).toBe(true);
      }
    }
  });
});

describe('GammeSchema', () => {
  it.each(['default', 'premium', 'performance-v2', 'a', '0'])('accepte %s', g => {
    expect(GammeSchema.safeParse(g).success).toBe(true);
  });

  it.each([
    ['PREMIUM', 'majuscules'],
    ['pre mium', 'espace'],
    ['pre_mium', 'tiret bas'],
    ['../etc', 'chemin'],
    ['', 'vide'],
    ['a'.repeat(51), 'trop long'],
  ])('refuse %s (%s)', g => {
    expect(GammeSchema.safeParse(g).success).toBe(false);
  });
});

describe('GammeParamSchema', () => {
  it('reste permissif — la v1 acceptait une saisie libre puis normalisait', () => {
    expect(GammeParamSchema.safeParse('PREMIUM').success).toBe(true);
    expect(GammeParamSchema.safeParse('START Plus!').success).toBe(true);
  });

  it('borne tout de même la longueur', () => {
    expect(GammeParamSchema.safeParse('a'.repeat(101)).success).toBe(false);
    expect(GammeParamSchema.safeParse('').success).toBe(false);
  });
});

describe('SaveProfileSchema', () => {
  const settings = defaultAnalysisSettings();

  it('accepte un corps minimal', () => {
    expect(SaveProfileSchema.safeParse({ settings }).success).toBe(true);
  });

  it('accepte les métadonnées et la version attendue', () => {
    const result = SaveProfileSchema.safeParse({
      settings,
      label: 'Premium',
      description: 'Gamme haut de gamme',
      expectedVersion: 3,
    });
    expect(result.success).toBe(true);
  });

  it('accepte une description explicitement nulle — c’est un effacement voulu', () => {
    expect(SaveProfileSchema.safeParse({ settings, description: null }).success).toBe(true);
  });

  it('REJETTE une clé surnuméraire — pas de mass assignment sur les métadonnées', () => {
    const result = SaveProfileSchema.safeParse({ settings, version: 99, updatedBy: 'root' });
    expect(result.success).toBe(false);
  });

  it('refuse une version attendue négative', () => {
    expect(SaveProfileSchema.safeParse({ settings, expectedVersion: -1 }).success).toBe(false);
  });

  it('exige les réglages', () => {
    expect(SaveProfileSchema.safeParse({ label: 'Premium' }).success).toBe(false);
  });
});

describe('ProfileExportSchema', () => {
  function exportEnvelope(over: Record<string, unknown> = {}) {
    return {
      formatVersion: PROFILE_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      profile: 'premium',
      label: 'Premium',
      description: null,
      sourceVersion: 4,
      settings: defaultAnalysisSettings(),
      ...over,
    };
  }

  it('accepte une enveloppe conforme', () => {
    expect(ProfileExportSchema.safeParse(exportEnvelope()).success).toBe(true);
  });

  it('REFUSE un format de version inconnu — un fichier d’un futur format n’est pas relisible', () => {
    expect(ProfileExportSchema.safeParse(exportEnvelope({ formatVersion: 2 })).success).toBe(false);
  });

  it('refuse une gamme non normalisée dans l’enveloppe', () => {
    expect(ProfileExportSchema.safeParse(exportEnvelope({ profile: 'PREMIUM' })).success).toBe(
      false,
    );
  });

  it('rejette une clé surnuméraire', () => {
    expect(ProfileExportSchema.safeParse(exportEnvelope({ malveillant: true })).success).toBe(
      false,
    );
  });

  it('valide les réglages embarqués', () => {
    const result = ProfileExportSchema.safeParse(
      exportEnvelope({ settings: { inconnu: 'valeur' } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('ImportProfileSchema', () => {
  const payload = {
    formatVersion: PROFILE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: 'premium',
    label: 'Premium',
    description: null,
    sourceVersion: 1,
    settings: defaultAnalysisSettings(),
  };

  it('accepte une enveloppe seule', () => {
    expect(ImportProfileSchema.safeParse({ payload }).success).toBe(true);
  });

  it('accepte une version attendue pour un import sous verrouillage', () => {
    expect(ImportProfileSchema.safeParse({ payload, expectedVersion: 2 }).success).toBe(true);
  });

  it('rejette une clé surnuméraire', () => {
    expect(ImportProfileSchema.safeParse({ payload, force: true }).success).toBe(false);
  });
});

describe('constantes', () => {
  it('nomme le profil de repli « default »', () => {
    expect(DEFAULT_PROFILE).toBe('default');
    expect(GammeSchema.safeParse(DEFAULT_PROFILE).success).toBe(true);
  });
});
