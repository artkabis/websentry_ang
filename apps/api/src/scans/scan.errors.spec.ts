import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import {
  ScanPageNotFoundError,
  ScanReportPurgedError,
  ScanSessionNotFoundError,
  SessionsNotComparableError,
} from './scan.errors.js';

describe('ScanPageNotFoundError', () => {
  it('répond 404', () => {
    expect(new ScanPageNotFoundError().getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('NE PEUT PAS reprendre l’identifiant demandé en écho', () => {
    // L'historique est lisible par des comptes qui n'ont pas accès à tous les
    // sites : un 404 qui renvoie l'entrée devient un oracle d'existence. Le
    // constructeur ne prend AUCUN argument — l'écho est impossible par
    // construction, pas seulement évité par discipline.
    expect(ScanPageNotFoundError.length).toBe(0);
    expect(JSON.stringify(new ScanPageNotFoundError().getResponse())).not.toContain('33333333');
  });
});

describe('ScanSessionNotFoundError', () => {
  it('répond 404', () => {
    expect(new ScanSessionNotFoundError().getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});

describe('ScanReportPurgedError', () => {
  it('répond 410 Gone, et non 404', () => {
    // Un 404 envoie l'utilisateur — et le support avec lui — chercher une
    // donnée que l'application a elle-même supprimée.
    expect(new ScanReportPurgedError('2026-01-15T03:00:00.000Z').getStatus()).toBe(HttpStatus.GONE);
  });

  it('EMPORTE le résumé promis par son message', async () => {
    // « Le résumé des critères reste consultable » : si la réponse ne le porte
    // pas, un lien ouvert directement — signet, message d'un collègue — n'a
    // rien à afficher, et la promesse devient fausse.
    const { ScanPageSchema } = await import('@websentry/shared');
    const scan = ScanPageSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      url: 'https://exemple.fr/',
      domain: 'exemple.fr',
      gamme: 'premium',
      epj: null,
      platform: 'generic',
      globalScore: 4.2,
      statusCode: 200,
      analyzedAt: '2026-01-10T09:00:00.000Z',
      durationMs: 1200,
      checkSummary: { METAS: 'pass' },
      metadata: null,
      launchedBy: null,
      reportState: 'purged',
    });

    const body = new ScanReportPurgedError('2026-01-15T03:00:00.000Z', scan).getResponse() as {
      details: { scan?: { globalScore: number | null; checkSummary: Record<string, string> } };
    };

    expect(body.details.scan?.globalScore).toBe(4.2);
    expect(body.details.scan?.checkSummary).toEqual({ METAS: 'pass' });
  });

  it('se passe du résumé quand il n’est pas fourni', () => {
    const body = new ScanReportPurgedError(null).getResponse() as {
      details: Record<string, unknown>;
    };

    expect('scan' in body.details).toBe(false);
  });

  it('dit QUAND la purge a eu lieu', () => {
    const body = new ScanReportPurgedError('2026-01-15T03:00:00.000Z').getResponse() as {
      message: string;
      details: { purgedAt: string | null };
    };
    expect(body.message).toContain('2026-01-15');
    expect(body.details.purgedAt).toBe('2026-01-15T03:00:00.000Z');
  });

  it('reste exploitable sans date — les lignes purgées par la v1 n’en ont pas', () => {
    const body = new ScanReportPurgedError(null).getResponse() as {
      message: string;
      details: { purgedAt: string | null };
    };
    expect(body.message).toContain('purgé par la politique de rétention');
    expect(body.details.purgedAt).toBeNull();
  });

  it('rappelle ce qui reste consultable', () => {
    // Le résumé des critères survit à la purge : le dire évite une demande de
    // restauration inutile.
    const body = new ScanReportPurgedError(null).getResponse() as { message: string };
    expect(body.message).toContain('résumé des critères reste consultable');
  });
});

describe('SessionsNotComparableError', () => {
  it('répond 400', () => {
    expect(new SessionsNotComparableError().getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('explique pourquoi le rapprochement n’a pas de sens', () => {
    // Sans refus, la comparaison « réussirait » en annonçant que toutes les
    // pages ont disparu et que toutes les autres sont apparues.
    const body = new SessionsNotComparableError().getResponse() as { message: string };
    expect(body.message).toContain('sites différents');
  });
});
