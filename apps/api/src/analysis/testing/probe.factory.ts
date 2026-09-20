import type { NetworkProbe } from '../network-probe.js';

/**
 * Complète une sonde simulée par sa vue de critère.
 *
 * Une vraie vue se rend elle-même (`forCheck`), parce qu'un critère n'a qu'un
 * quota. Le rappeler ici évite de le réécrire dans chaque test — et garantit
 * que les doubles se comportent comme la sonde qu'ils remplacent.
 */
export function asProbe(parts: Omit<NetworkProbe, 'forCheck'>): NetworkProbe {
  const probe: NetworkProbe = { ...parts, forCheck: () => probe };
  return probe;
}
