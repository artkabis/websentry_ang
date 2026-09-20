import { describe, expect, it } from 'vitest';
import { publicMessageOf } from './sse-writer.js';
import { SsrfBlockedError } from '../security/ssrf.service.js';

describe('publicMessageOf', () => {
  it('dit FRANCHEMENT qu’une URL est refusée par politique', () => {
    // L'utilisateur doit comprendre que l'URL est bloquée, non que le site est
    // en panne — sinon il rouvre un ticket contre le site analysé.
    const message = publicMessageOf(new SsrfBlockedError('192.168.1.1 est dans une plage privée'));
    expect(message).toContain('adresse non publique');
  });

  it('NE RECOPIE PAS le détail d’un blocage SSRF', () => {
    // Le message interne cite l'IP résolue : la relayer dans un flux public
    // cartographierait le réseau interne.
    const message = publicMessageOf(new SsrfBlockedError('résolu vers 10.0.0.5 (plage privée)'));
    expect(message).not.toContain('10.0.0.5');
  });

  it('distingue le dépassement de délai', () => {
    const error = new Error('fetch timed out');
    error.name = 'TimeoutError';
    expect(publicMessageOf(error)).toContain('délai');
  });

  it('NE FUITE RIEN sur une erreur réseau brute', () => {
    // Un message d'undici cite hôte, port et code système : autant
    // d'informations sur le réseau interne qu'un flux public n'a pas à porter.
    const message = publicMessageOf(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 (db-primary.internal)'),
    );
    expect(message).not.toContain('10.0.0.5');
    expect(message).not.toContain('ECONNREFUSED');
    expect(message).not.toContain('internal');
  });

  it('reste exploitable sur une valeur qui n’est pas une erreur', () => {
    expect(publicMessageOf('boum')).toContain('analyse a échoué');
    expect(publicMessageOf(null)).toContain('analyse a échoué');
  });
});
