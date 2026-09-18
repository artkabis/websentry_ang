import { describe, expect, it } from 'vitest';
import {
  BulkDeleteSchema,
  CheckSummarySchema,
  DateBoundSchema,
  MAX_BULK_DELETE,
  MAX_INGEST_PAGES,
  ProfileSnapshotSchema,
  ReportStateSchema,
  ScanIngestSchema,
  ScanPageSchema,
  ScanSearchQuerySchema,
  ScanStatsSchema,
  SessionReportSchema,
  SiteDeleteSchema,
  SiteSelectorSchema,
  SiteSummarySchema,
  siteIdentityKey,
} from './scan.schema.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

describe('CheckSummarySchema', () => {
  it('accepte un résumé conforme', () => {
    const result = CheckSummarySchema.safeParse({ HN_STRUCTURE: 'pass', METAS: 'warning' });
    expect(result.success).toBe(true);
  });

  it('accepte un sous-critère pointé', () => {
    expect(CheckSummarySchema.safeParse({ 'METAS.title': 'fail' }).success).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'REJETTE la clé %s au lieu de la filtrer en silence',
    key => {
      // `z.record` écarterait la clé sans rien dire : la tentative de pollution
      // ne laisserait aucune trace. On veut une erreur nommée.
      const result = CheckSummarySchema.safeParse(JSON.parse(`{"${key}": "pass"}`));
      expect(result.success).toBe(false);
    },
  );

  it('ne pollue jamais Object.prototype', () => {
    CheckSummarySchema.safeParse(JSON.parse('{"__proto__": {"pollue": true}}'));
    expect(({} as Record<string, unknown>).pollue).toBeUndefined();
  });

  it('refuse un identifiant de critère hors motif', () => {
    expect(CheckSummarySchema.safeParse({ 'critère invalide': 'pass' }).success).toBe(false);
  });

  it('refuse un statut inconnu', () => {
    expect(CheckSummarySchema.safeParse({ METAS: 'broken' }).success).toBe(false);
  });

  it('laisse passer une entrée non objet au préprocesseur, que le schéma rejette ensuite', () => {
    expect(CheckSummarySchema.safeParse(['METAS']).success).toBe(false);
    expect(CheckSummarySchema.safeParse(null).success).toBe(false);
  });
});

describe('DateBoundSchema', () => {
  it.each(['2026-06-04', '2026-06-04T10:00:00Z', '2026-06-04T10:00:00+02:00'])(
    'accepte %s',
    value => {
      expect(DateBoundSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['04/06/2026', '2026-6-4', 'hier', '2026-06-04T10:00:00'])('refuse %s', value => {
    // La dernière forme n'a pas de fuseau : l'interpréter reviendrait à choisir
    // celui du serveur, et à décaler la borne sans le dire.
    expect(DateBoundSchema.safeParse(value).success).toBe(false);
  });
});

describe('ScanSearchQuerySchema', () => {
  it('applique les valeurs par défaut', () => {
    const result = ScanSearchQuerySchema.parse({});
    expect(result).toMatchObject({ page: 1, limit: 20, sort: 'analyzedAt', order: 'desc' });
  });

  it('coerce les nombres reçus en chaînes — une query string ne porte que du texte', () => {
    const result = ScanSearchQuerySchema.parse({ page: '3', limit: '50', scoreMin: '2.5' });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(50);
    expect(result.scoreMin).toBe(2.5);
  });

  it('plafonne la taille de page', () => {
    expect(ScanSearchQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('REJETTE tout paramètre surnuméraire', () => {
    expect(ScanSearchQuerySchema.safeParse({ orderBy: 'url; DROP TABLE' }).success).toBe(false);
  });

  it('refuse une colonne de tri hors liste', () => {
    // Le tri est la seule valeur qui atteint la structure de la requête SQL :
    // la liste fermée est ce qui rend l'injection impossible en amont.
    expect(ScanSearchQuerySchema.safeParse({ sort: 'analyzed_at) --' }).success).toBe(false);
  });

  it('signale un intervalle de score inversé', () => {
    const result = ScanSearchQuerySchema.safeParse({ scoreMin: 4, scoreMax: 2 });
    expect(result.success).toBe(false);
  });

  it('signale un intervalle de dates inversé', () => {
    const result = ScanSearchQuerySchema.safeParse({
      dateFrom: '2026-06-10',
      dateTo: '2026-06-01',
    });
    expect(result.success).toBe(false);
  });

  it('accepte un intervalle de dates cohérent', () => {
    expect(
      ScanSearchQuerySchema.safeParse({ dateFrom: '2026-06-01', dateTo: '2026-06-10' }).success,
    ).toBe(true);
  });

  it('accepte des bornes égales', () => {
    expect(
      ScanSearchQuerySchema.safeParse({
        scoreMin: 3,
        scoreMax: 3,
        dateFrom: '2026-06-01',
        dateTo: '2026-06-01',
      }).success,
    ).toBe(true);
  });

  it('refuse un identifiant de session qui n’est pas un UUID', () => {
    expect(ScanSearchQuerySchema.safeParse({ sessionId: 'abc' }).success).toBe(false);
  });
});

describe('ScanPageSchema', () => {
  const page = {
    id: UUID_A,
    sessionId: UUID_B,
    url: 'https://exemple.fr/accueil',
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: 'ABC-123',
    platform: 'duda',
    globalScore: 4.2,
    statusCode: 200,
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1234,
    checkSummary: { METAS: 'pass' },
    metadata: { siteAlias: 'exemple' },
    launchedBy: 'alice',
    reportState: 'inline',
  };

  it('accepte une page conforme', () => {
    expect(ScanPageSchema.safeParse(page).success).toBe(true);
  });

  it('accepte les champs facultatifs à null', () => {
    const result = ScanPageSchema.safeParse({
      ...page,
      gamme: null,
      epj: null,
      platform: null,
      globalScore: null,
      statusCode: null,
      durationMs: null,
      metadata: null,
      launchedBy: null,
    });
    expect(result.success).toBe(true);
  });

  it('refuse un score hors échelle — la notation va de 0 à 5', () => {
    expect(ScanPageSchema.safeParse({ ...page, globalScore: 16.4 }).success).toBe(false);
  });

  it('REJETTE un rapport complet glissé dans la liste', () => {
    // La liste est servie à tout détenteur de `history:read` ; le rapport, lui,
    // ne sort que par la route de détail. Le contrat l'interdit ici.
    expect(ScanPageSchema.safeParse({ ...page, report: { checks: {} } }).success).toBe(false);
  });

  it('refuse un état de rapport inventé', () => {
    expect(ScanPageSchema.safeParse({ ...page, reportState: 'archived' }).success).toBe(false);
  });

  it.each(['inline', 'compressed', 'purged'])('accepte l’état %s', state => {
    expect(ReportStateSchema.safeParse(state).success).toBe(true);
  });
});

describe('SiteSummarySchema', () => {
  it('accepte un site sans session', () => {
    const result = SiteSummarySchema.safeParse({
      siteId: UUID_A,
      domain: 'exemple.fr',
      gamme: null,
      epj: null,
      lastSessionId: null,
      pageCount: 0,
      avgScore: null,
      minScore: null,
      maxScore: null,
      lastScan: '2026-06-04T10:00:00.000Z',
      sessionCount: 0,
      launchedBy: null,
      metadata: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('ProfileSnapshotSchema', () => {
  it('accepte un instantané minimal', () => {
    expect(
      ProfileSnapshotSchema.safeParse({ enabledChecks: ['METAS'], enabledSubChecks: [] }).success,
    ).toBe(true);
  });

  it('borne le nombre de critères — un instantané n’est pas un fourre-tout', () => {
    const huge = Array.from({ length: 501 }, (_, i) => `CHECK_${i}`);
    expect(
      ProfileSnapshotSchema.safeParse({ enabledChecks: huge, enabledSubChecks: [] }).success,
    ).toBe(false);
  });
});

describe('SessionReportSchema', () => {
  const base = {
    sessionId: UUID_A,
    siteId: UUID_B,
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: null,
    platform: 'duda',
    launchedBy: 'alice',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 5000,
    pageCount: 1,
    avgScore: 4,
    minScore: 4,
    maxScore: 4,
    truncated: false,
    profileSnapshot: null,
    pages: [
      {
        id: UUID_C,
        url: 'https://exemple.fr/',
        globalScore: 4,
        statusCode: 200,
        analyzedAt: '2026-06-04T10:00:00.000Z',
        checkSummary: { METAS: 'pass' },
        reportState: 'inline',
        report: { checks: {} },
        error: null,
      },
    ],
  };

  it('accepte un rapport de session conforme', () => {
    expect(SessionReportSchema.safeParse(base).success).toBe(true);
  });

  it('accepte une page purgée, rapport absent et état explicite', () => {
    const purged = {
      ...base,
      pages: [{ ...base.pages[0], report: null, reportState: 'purged', error: null }],
    };
    expect(SessionReportSchema.safeParse(purged).success).toBe(true);
  });

  it('laisse le rapport libre de forme — l’historique n’a pas à figer le module d’analyse', () => {
    const exotic = {
      ...base,
      pages: [{ ...base.pages[0], report: { toute: ['forme', { imaginable: 1 }] } }],
    };
    expect(SessionReportSchema.safeParse(exotic).success).toBe(true);
  });
});

describe('ScanStatsSchema', () => {
  it('accepte des statistiques complètes', () => {
    const result = ScanStatsSchema.safeParse({
      total: 100,
      sites: 10,
      sessions: 20,
      inline: 60,
      compressed: 30,
      purged: 10,
      avgScore: 3.7,
      oldest: '2026-01-01T00:00:00.000Z',
      newest: '2026-06-04T10:00:00.000Z',
      storageBytesGz: 12345,
      byGamme: [{ gamme: 'premium', count: 50, avgScore: 4 }],
      scoreDistribution: { good: 40, warning: 30, critical: 20, unknown: 10 },
      topDomains: [{ domain: 'exemple.fr', count: 12, avgScore: 3.9 }],
      computedAt: '2026-06-04T10:05:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('refuse un décompte négatif', () => {
    expect(
      ScanStatsSchema.safeParse({
        total: -1,
        sites: 0,
        sessions: 0,
        inline: 0,
        compressed: 0,
        purged: 0,
        avgScore: null,
        oldest: null,
        newest: null,
        storageBytesGz: 0,
        byGamme: [],
        scoreDistribution: { good: 0, warning: 0, critical: 0, unknown: 0 },
        topDomains: [],
        computedAt: '2026-06-04T10:05:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('BulkDeleteSchema', () => {
  it('accepte une liste d’identifiants', () => {
    expect(BulkDeleteSchema.safeParse({ ids: [UUID_A, UUID_B] }).success).toBe(true);
  });

  it('refuse une liste vide — une suppression sans cible est une erreur d’appel', () => {
    expect(BulkDeleteSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('borne la taille du lot', () => {
    const ids = Array.from({ length: MAX_BULK_DELETE + 1 }, () => UUID_A);
    expect(BulkDeleteSchema.safeParse({ ids }).success).toBe(false);
  });

  it('refuse un identifiant qui n’est pas un UUID', () => {
    expect(BulkDeleteSchema.safeParse({ ids: ["1' OR '1'='1"] }).success).toBe(false);
  });
});

describe('SiteDeleteSchema', () => {
  it('EXIGE le champ gamme, y compris null', () => {
    // `null` désigne le site SANS gamme. Rendre le champ facultatif laisserait
    // croire que l'omettre vise « toutes les gammes » — et effacerait bien plus
    // que ce que l'appelant a demandé.
    expect(SiteDeleteSchema.safeParse({ domain: 'exemple.fr' }).success).toBe(false);
    expect(SiteDeleteSchema.safeParse({ domain: 'exemple.fr', gamme: null }).success).toBe(true);
    expect(SiteDeleteSchema.safeParse({ domain: 'exemple.fr', gamme: 'premium' }).success).toBe(
      true,
    );
  });
});

describe('SiteSelectorSchema', () => {
  it('lit les coordonnées d’un site avec sa gamme', () => {
    expect(SiteSelectorSchema.parse({ domain: 'exemple.fr', gamme: 'premium' })).toEqual({
      domain: 'exemple.fr',
      gamme: 'premium',
    });
  });

  it.each([
    ['absente', {}],
    ['vide', { gamme: '' }],
  ])('traite une gamme %s comme « sans gamme »', (_label, over) => {
    // Un formulaire dont le champ n'est pas rempli envoie `gamme=` : distinguer
    // les deux formes ferait échouer la recherche d'un site sans gamme dès
    // qu'elle passe par l'interface plutôt que par un lien construit à la main.
    const result = SiteSelectorSchema.parse({ domain: 'exemple.fr', ...over });
    expect(result.gamme).toBeNull();
  });

  it('exige le domaine', () => {
    expect(SiteSelectorSchema.safeParse({ gamme: 'premium' }).success).toBe(false);
  });

  it('refuse un paramètre surnuméraire', () => {
    expect(SiteSelectorSchema.safeParse({ domain: 'exemple.fr', siteId: UUID_A }).success).toBe(
      false,
    );
  });
});

describe('ScanIngestSchema', () => {
  const ingest = {
    sessionId: UUID_A,
    domain: 'exemple.fr',
    gamme: 'premium',
    epj: 'ABC-123',
    platform: 'duda',
    siteAlias: 'exemple',
    metadata: null,
    launchedBy: 'alice',
    durationMs: 4200,
    profileSnapshot: null,
    pages: [
      {
        url: 'https://exemple.fr/',
        globalScore: 4,
        statusCode: 200,
        analyzedAt: '2026-06-04T10:00:00.000Z',
        durationMs: 1200,
        checkSummary: { METAS: 'pass' },
        report: { checks: {} },
      },
    ],
  };

  it('accepte une session d’ingestion conforme', () => {
    expect(ScanIngestSchema.safeParse(ingest).success).toBe(true);
  });

  it('refuse une session sans page', () => {
    expect(ScanIngestSchema.safeParse({ ...ingest, pages: [] }).success).toBe(false);
  });

  it('refuse une URL non absolue', () => {
    const bad = { ...ingest, pages: [{ ...ingest.pages[0], url: '/accueil' }] };
    expect(ScanIngestSchema.safeParse(bad).success).toBe(false);
  });

  it('exige un horodatage avec fuseau', () => {
    const bad = { ...ingest, pages: [{ ...ingest.pages[0], analyzedAt: '2026-06-04 10:00:00' }] };
    expect(ScanIngestSchema.safeParse(bad).success).toBe(false);
  });

  it('borne le nombre de pages plutôt que de tronquer en silence', () => {
    expect(MAX_INGEST_PAGES).toBeGreaterThan(0);
    const pages = Array.from({ length: MAX_INGEST_PAGES + 1 }, () => ingest.pages[0]);
    expect(ScanIngestSchema.safeParse({ ...ingest, pages }).success).toBe(false);
  });

  it('REJETTE un champ surnuméraire — pas d’écriture de colonne par la bande', () => {
    expect(ScanIngestSchema.safeParse({ ...ingest, siteId: UUID_B }).success).toBe(false);
  });
});

describe('siteIdentityKey', () => {
  it('distingue deux gammes du même domaine', () => {
    expect(siteIdentityKey('exemple.fr', 'premium')).not.toBe(
      siteIdentityKey('exemple.fr', 'start'),
    );
  });

  it('donne une clé stable au site sans gamme', () => {
    // Deux NULL ne sont jamais égaux en SQL : sans cette clé dérivée, le site
    // sans gamme serait dupliqué à chaque scan malgré la contrainte UNIQUE.
    expect(siteIdentityKey('exemple.fr', null)).toBe('exemple.fr|');
    expect(siteIdentityKey('exemple.fr', null)).toBe(siteIdentityKey('exemple.fr', null));
  });
});
