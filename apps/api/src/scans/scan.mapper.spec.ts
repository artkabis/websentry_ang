import { describe, expect, it } from 'vitest';
import {
  decodeJson,
  toAnalyzedAt,
  toCheckSummary,
  toInt,
  toIso,
  toNumber,
  toProfileSnapshot,
  toReportState,
  toScore,
  toSiteMetadata,
} from './scan.mapper.js';

describe('toNumber', () => {
  it('convertit un DECIMAL rendu en chaîne par le driver', () => {
    expect(toNumber('4.20')).toBe(4.2);
  });

  it('laisse passer un nombre', () => {
    expect(toNumber(3)).toBe(3);
  });

  it.each([null, undefined])('rend null pour %s', raw => {
    expect(toNumber(raw)).toBeNull();
  });

  it('rend null plutôt que NaN sur une colonne corrompue', () => {
    expect(toNumber('quatre')).toBeNull();
  });
});

describe('toScore', () => {
  it('arrondit au dixième', () => {
    expect(toScore('4.267')).toBe(4.3);
  });

  it.each([
    ['16.4', 5],
    ['-2', 0],
  ])('ramène %s dans l’échelle 0–5', (raw, expected) => {
    // Une valeur hors échelle vient d'une donnée corrompue. La rendre telle
    // quelle ferait échouer la validation du contrat à la frontière HTTP, donc
    // perdre TOUTE la page pour une seule colonne.
    expect(toScore(raw)).toBe(expected);
  });

  it('rend null pour une absence', () => {
    expect(toScore(null)).toBeNull();
  });
});

describe('toInt', () => {
  it('tronque vers zéro', () => {
    expect(toInt('200.9')).toBe(200);
  });

  it('rend null pour une absence', () => {
    expect(toInt(null)).toBeNull();
  });
});

describe('toIso', () => {
  it('interprète un DATETIME MariaDB comme de l’UTC', () => {
    // Le pool est en `dateStrings` : la colonne revient sans fuseau. Sans le
    // `Z` explicite, un serveur en Europe/Paris décalerait tout l'historique
    // de deux heures l'été.
    expect(toIso('2026-06-04 10:00:00')).toBe('2026-06-04T10:00:00.000Z');
  });

  it('ne dépend pas du fuseau du processus', () => {
    const before = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      expect(toIso('2026-06-04 10:00:00')).toBe('2026-06-04T10:00:00.000Z');
    } finally {
      process.env.TZ = before;
    }
  });

  it('accepte un Date, si le driver en rend un', () => {
    expect(toIso(new Date('2026-06-04T10:00:00Z'))).toBe('2026-06-04T10:00:00.000Z');
  });

  it('rend null pour une date invalide plutôt qu’« Invalid Date »', () => {
    expect(toIso('pas une date')).toBeNull();
    expect(toIso(new Date('x'))).toBeNull();
  });

  it.each([null, undefined])('rend null pour %s', raw => {
    expect(toIso(raw)).toBeNull();
  });
});

describe('toAnalyzedAt', () => {
  it('rend l’horodatage quand la colonne est lisible', () => {
    expect(toAnalyzedAt('2026-06-04 10:00:00')).toBe('2026-06-04T10:00:00.000Z');
  });

  it('retombe sur l’époque Unix sur une valeur corrompue', () => {
    // `analyzed_at` est NOT NULL dans les trois tables : une valeur illisible
    // signale une donnée corrompue. Une date de 1970 saute aux yeux dans
    // l'interface, là où faire échouer la lecture rendrait TOUT l'historique
    // inaccessible pour une seule ligne.
    expect(toAnalyzedAt('pas une date')).toBe('1970-01-01T00:00:00.000Z');
    expect(toAnalyzedAt(null)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('decodeJson', () => {
  it('laisse passer un objet déjà décodé par le driver', () => {
    const value = { a: 1 };
    expect(decodeJson(value)).toBe(value);
  });

  it('décode une chaîne JSON', () => {
    expect(decodeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('rend null sur du JSON illisible au lieu de propager l’exception', () => {
    expect(decodeJson('{cassé')).toBeNull();
  });

  it('rend null pour une absence', () => {
    expect(decodeJson(null)).toBeNull();
  });
});

describe('toCheckSummary', () => {
  it('valide un résumé conforme', () => {
    expect(toCheckSummary('{"METAS":"pass"}')).toEqual({ METAS: 'pass' });
  });

  it('rend un résumé VIDE sur une valeur invalide, sans faire échouer la page', () => {
    // L'historique doit rester consultable même dégradé : une ligne écrite par
    // une version antérieure du référentiel ne doit pas rendre la page illisible.
    expect(toCheckSummary('{"METAS":"exploded"}')).toEqual({});
  });

  it('écarte une tentative de pollution de prototype', () => {
    expect(toCheckSummary('{"__proto__":{"x":1}}')).toEqual({});
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('toSiteMetadata', () => {
  it('valide des métadonnées conformes', () => {
    expect(toSiteMetadata('{"siteAlias":"exemple"}')).toEqual({ siteAlias: 'exemple' });
  });

  it('rend null sur une forme inattendue', () => {
    expect(toSiteMetadata('{"siteAlias":42}')).toBeNull();
  });

  it('rend null pour une colonne vide', () => {
    expect(toSiteMetadata(null)).toBeNull();
  });
});

describe('toProfileSnapshot', () => {
  it('valide un instantané conforme', () => {
    const raw = '{"enabledChecks":["METAS"],"enabledSubChecks":[]}';
    expect(toProfileSnapshot(raw)).toEqual({ enabledChecks: ['METAS'], enabledSubChecks: [] });
  });

  it('rend null sur une forme inattendue', () => {
    expect(toProfileSnapshot('{"enabledChecks":"METAS"}')).toBeNull();
  });

  it('rend null pour une session antérieure à l’instantané', () => {
    expect(toProfileSnapshot(null)).toBeNull();
  });
});

describe('toReportState', () => {
  it('reconnaît un rapport en clair', () => {
    expect(toReportState({ is_compressed: 0, has_report: 1 })).toBe('inline');
  });

  it('reconnaît un rapport compressé', () => {
    expect(toReportState({ is_compressed: 1, has_report: 1 })).toBe('compressed');
  });

  it('reconnaît un rapport PURGÉ — la distinction qui manquait à la v1', () => {
    // La v1 rendait la ligne purgée indiscernable d'une page sans rapport, et
    // répondait 404 dans les deux cas.
    expect(toReportState({ is_compressed: 0, has_report: 0 })).toBe('purged');
  });

  it('retombe sur les colonnes brutes quand l’indicateur agrégé est absent', () => {
    expect(toReportState({ is_compressed: 0, report: '{}', report_gz: null })).toBe('inline');
    expect(toReportState({ is_compressed: 1, report: null, report_gz: Buffer.from('x') })).toBe(
      'compressed',
    );
    expect(toReportState({ is_compressed: 0, report: null, report_gz: null })).toBe('purged');
  });
});
