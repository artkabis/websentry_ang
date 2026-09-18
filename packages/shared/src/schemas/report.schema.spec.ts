import { describe, expect, it } from 'vitest';
import {
  AnalysisReportSchema,
  CheckItemSchema,
  CheckResultSchema,
  DudaParamsSchema,
  LinkEntrySchema,
  MAX_SOURCE_LENGTH,
  REPORTED_HEADERS,
  pickReportedHeaders,
} from './report.schema.js';

const ANALYZE_ID = '11111111-1111-4111-8111-111111111111';

function checkResult(over: Record<string, unknown> = {}) {
  return {
    checkId: 'METAS',
    checkTitle: 'Balises meta',
    globalScore: 4,
    status: 'warning',
    items: [{ label: 'Titre', status: 'pass', value: 'Accueil' }],
    summary: 'Un titre présent, une description absente.',
    recommendations: ['Ajouter une meta description.'],
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    analyzeId: ANALYZE_ID,
    url: 'https://exemple.fr/',
    title: 'Accueil',
    analyzedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 1200,
    globalScore: 4.2,
    platform: 'duda',
    renderMode: 'static',
    statusCode: 200,
    ttfb: 120,
    redirectChain: [],
    htmlSize: 45_000,
    httpHeaders: { 'content-type': 'text/html' },
    dudaParams: null,
    checks: { METAS: checkResult() },
    ...over,
  };
}

describe('CheckItemSchema', () => {
  it('accepte un item minimal', () => {
    expect(CheckItemSchema.safeParse({ label: 'Titre', status: 'pass' }).success).toBe(true);
  });

  it('accepte les quatre formes de valeur', () => {
    for (const value of ['texte', 42, true, null]) {
      expect(CheckItemSchema.safeParse({ label: 'x', status: 'pass', value }).success).toBe(true);
    }
  });

  it('BORNE l’extrait de source', () => {
    // Sans borne, un `outerHTML` non tronqué ferait voyager la page entière
    // dans chaque item — et la base la stockerait.
    const source = 'x'.repeat(MAX_SOURCE_LENGTH + 1);
    expect(CheckItemSchema.safeParse({ label: 'x', status: 'fail', source }).success).toBe(false);
  });

  it('accepte un ancrage de texte', () => {
    const locator = { text: 'Cliquez ici', prefix: 'Pour en savoir plus, ' };
    expect(CheckItemSchema.safeParse({ label: 'x', status: 'warning', locator }).success).toBe(
      true,
    );
  });

  it('refuse un champ surnuméraire', () => {
    expect(
      CheckItemSchema.safeParse({ label: 'x', status: 'pass', selector: 'body > div' }).success,
    ).toBe(false);
  });
});

describe('CheckResultSchema', () => {
  it('accepte un résultat conforme', () => {
    expect(CheckResultSchema.safeParse(checkResult()).success).toBe(true);
  });

  it('refuse un score hors échelle', () => {
    expect(CheckResultSchema.safeParse(checkResult({ globalScore: 12 })).success).toBe(false);
  });

  it('accepte les sorties annexes de cartographie', () => {
    const result = CheckResultSchema.safeParse(
      checkResult({
        checkId: 'LINKS',
        contentLinks: ['https://exemple.fr/a'],
        linkMap: [
          {
            href: 'https://exemple.fr/a',
            anchor: 'En savoir plus',
            zone: 'content',
            type: 'text',
            isInternal: true,
            isGenericAnchor: true,
            targetIsAnchor: false,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('refuse une zone de lien inventée', () => {
    expect(
      LinkEntrySchema.safeParse({
        href: 'https://exemple.fr/',
        anchor: 'x',
        zone: 'carrousel',
        type: 'text',
        isInternal: true,
        isGenericAnchor: false,
        targetIsAnchor: false,
      }).success,
    ).toBe(false);
  });
});

describe('pickReportedHeaders', () => {
  it('retient les en-têtes de la liste fermée', () => {
    const kept = pickReportedHeaders({ 'Content-Type': 'text/html', Server: 'nginx' });
    expect(kept).toEqual({ 'content-type': 'text/html', server: 'nginx' });
  });

  it('ÉCARTE tout ce qui n’y figure pas', () => {
    // Un rapport est stocké puis relu par des tiers : recopier tous les
    // en-têtes y ferait entrer cookies et jetons sans que personne ne l'ait
    // décidé.
    const kept = pickReportedHeaders({
      'set-cookie': 'session=secret',
      authorization: 'Bearer x',
      'x-internal-backend': 'srv-01',
    });
    expect(kept).toEqual({});
  });

  it('normalise la casse des noms', () => {
    expect(pickReportedHeaders({ 'CACHE-CONTROL': 'no-store' })).toEqual({
      'cache-control': 'no-store',
    });
  });

  it('ne laisse aucun doublon dans la liste', () => {
    expect(new Set(REPORTED_HEADERS).size).toBe(REPORTED_HEADERS.length);
  });
});

describe('DudaParamsSchema', () => {
  it('accepte des paramètres entièrement nuls', () => {
    const empty = Object.fromEntries(Object.keys(DudaParamsSchema.shape).map(key => [key, null]));
    expect(DudaParamsSchema.safeParse(empty).success).toBe(true);
  });
});

describe('AnalysisReportSchema', () => {
  it('accepte un rapport conforme', () => {
    expect(AnalysisReportSchema.safeParse(report()).success).toBe(true);
  });

  it('exige un identifiant d’analyse au format UUID', () => {
    expect(AnalysisReportSchema.safeParse(report({ analyzeId: 'analyse-1' })).success).toBe(false);
  });

  it('refuse un score global hors échelle', () => {
    expect(AnalysisReportSchema.safeParse(report({ globalScore: 16.4 })).success).toBe(false);
  });

  it('BORNE la chaîne de redirections', () => {
    // Une boucle de redirection ne doit pas produire un rapport sans fin.
    const chain = Array.from({ length: 21 }, () => ({ url: 'https://a.fr/', status: 301 }));
    expect(AnalysisReportSchema.safeParse(report({ redirectChain: chain })).success).toBe(false);
  });

  it('refuse une plateforme inconnue', () => {
    expect(AnalysisReportSchema.safeParse(report({ platform: 'shopify' })).success).toBe(false);
  });

  it('REJETTE un champ surnuméraire — pas de canal de sortie par la bande', () => {
    expect(AnalysisReportSchema.safeParse({ ...report(), rawHtml: '<html>' }).success).toBe(false);
  });

  it('accepte une chaîne de redirections renseignée', () => {
    const chain = [{ url: 'http://exemple.fr/', status: 301 }];
    expect(AnalysisReportSchema.safeParse(report({ redirectChain: chain })).success).toBe(true);
  });
});
