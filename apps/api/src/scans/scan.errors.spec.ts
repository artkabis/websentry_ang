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
