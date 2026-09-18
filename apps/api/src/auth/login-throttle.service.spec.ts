import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LoginThrottleService } from './login-throttle.service.js';

describe('LoginThrottleService', () => {
  let service: LoginThrottleService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new LoginThrottleService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('autorise les 10 premières tentatives', () => {
    for (let i = 0; i < 10; i++) {
      expect(service.hit('1.2.3.4', 'alice')).toBe(0);
    }
  });

  it('refuse à partir de la 11e tentative, avec un délai d’attente', () => {
    for (let i = 0; i < 10; i++) service.hit('1.2.3.4', 'alice');
    const retryAfter = service.hit('1.2.3.4', 'alice');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it('compte séparément deux identifiants depuis la MÊME IP', () => {
    // Derrière un NAT, un utilisateur ne doit pas bloquer ses collègues.
    for (let i = 0; i < 11; i++) service.hit('1.2.3.4', 'alice');
    expect(service.hit('1.2.3.4', 'bob')).toBe(0);
  });

  it('compte séparément le MÊME identifiant depuis deux IP', () => {
    for (let i = 0; i < 11; i++) service.hit('1.2.3.4', 'alice');
    expect(service.hit('5.6.7.8', 'alice')).toBe(0);
  });

  it('rouvre le quota une fois la fenêtre écoulée', () => {
    for (let i = 0; i < 11; i++) service.hit('1.2.3.4', 'alice');
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(service.hit('1.2.3.4', 'alice')).toBe(0);
  });

  it('remet le compteur à zéro après une connexion réussie', () => {
    for (let i = 0; i < 10; i++) service.hit('1.2.3.4', 'alice');
    service.clear('1.2.3.4', 'alice');
    expect(service.hit('1.2.3.4', 'alice')).toBe(0);
  });

  it('purge les fenêtres échues — sinon la table croîtrait sans borne', () => {
    // Un bombardement d'identifiants aléatoires créerait autant d'entrées : sans
    // balayage, c'est une fuite mémoire exploitable.
    for (let i = 0; i < 500; i++) service.hit('1.2.3.4', `user-${i}`);
    vi.advanceTimersByTime(15 * 60_000 + 60_000 + 1);

    // Après purge, chaque clé repart d'une fenêtre neuve.
    expect(service.hit('1.2.3.4', 'user-0')).toBe(0);
  });

  it('libère ses ressources à l’arrêt du module', () => {
    service.hit('1.2.3.4', 'alice');
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
