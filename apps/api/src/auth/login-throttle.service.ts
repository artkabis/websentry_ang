import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Limiteur de tentatives de connexion par couple (IP, identifiant).
 *
 * Le rate-limit par IP seul est insuffisant : derrière un NAT ou un VPN
 * d'entreprise, un utilisateur qui épuise le quota bloquerait tous ses collègues.
 * Chaque couple dispose donc de son propre compteur ; la limite volumétrique par IP
 * (`@nestjs/throttler`) reste active en garde secondaire.
 *
 * Ce compteur est EN MÉMOIRE — il protège une instance. Le verrouillage durable
 * d'un compte, lui, est persisté dans `users.locked_until` et survit au redémarrage
 * comme à la répartition de charge.
 */

interface Window {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class LoginThrottleService implements OnModuleDestroy {
  private readonly windows = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    // Balayage périodique : sans lui, la Map croîtrait indéfiniment sous un
    // bombardement d'identifiants aléatoires (fuite mémoire exploitable).
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    this.windows.clear();
  }

  /**
   * Enregistre une tentative.
   *
   * @returns 0 si autorisée, sinon le nombre de secondes à attendre (`Retry-After`).
   */
  hit(ip: string, username: string): number {
    const key = `${ip}:${username}`;
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return 0;
    }

    entry.count += 1;
    return entry.count > MAX_ATTEMPTS ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  /** Efface le compteur après une authentification réussie. */
  clear(ip: string, username: string): void {
    this.windows.delete(`${ip}:${username}`);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key);
    }
  }
}
