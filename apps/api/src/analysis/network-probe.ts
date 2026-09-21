import type { ProbeEngine } from './probe-engine.js';

/**
 * Sonde réseau des analyseurs.
 *
 * Quatre critères doivent contacter des ressources distantes : poids des
 * images, liens cassés, robots.txt, page de mentions légales. Toutes ces URL
 * viennent du DOM d'une page TIERCE — c'est exactement le cas que la politique
 * SSRF existe pour traiter. La sonde est donc la SEULE porte de sortie offerte
 * à un analyseur : elle ne prend pas de `dispatcher`, ne laisse pas passer
 * d'en-têtes arbitraires, et ne rend jamais un corps brut.
 *
 * Elle ne lève pas non plus. Un analyseur reçoit un résultat décrivant
 * l'échec ; sans cela, une URL injoignable ferait tomber le critère entier
 * alors que c'est précisément ce qu'il est censé constater.
 *
 * Le budget est RÉPARTI À L'AVANCE entre les critères (`CHECK_QUOTAS`). Une
 * enveloppe commune se distribuerait dans l'ordre où les analyseurs se
 * réveillent — c'est-à-dire au hasard de l'ordonnancement : deux analyses de la
 * même page rendraient alors deux rapports différents, l'une ayant pesé les
 * images, l'autre vérifié les liens. Un audit qui bouge d'une exécution à
 * l'autre n'est pas un audit.
 */

/** Issue d'une vérification — jamais une exception. */
export interface ProbeResult {
  url: string;
  /** Statut HTTP final, `null` si la requête n'a pas abouti. */
  status: number | null;
  ok: boolean;
  redirected: boolean;
  finalUrl: string;
  /** `Content-Length` exploitable, `null` si absent ou non numérique. */
  contentLength: number | null;
  contentType: string | null;
  /** Renseigné quand la requête a échoué — message assaini, jamais la cause brute. */
  error?: string;
  /** Vrai quand c'est la politique SSRF qui a refusé, pas le réseau. */
  blocked?: boolean;
  /**
   * Vrai quand l'URL n'a pas été vérifiée faute de quota.
   *
   * Ce n'est PAS un constat sur la ressource : c'est une limite que nous nous
   * imposons. Un analyseur qui la confondrait avec un échec accuserait le site
   * audité de notre propre plafond.
   */
  exhausted?: boolean;
}

export interface NetworkProbe {
  /** Vérifie une URL (HEAD, repli GET si la méthode est refusée). */
  check(url: string): Promise<ProbeResult>;
  /** Vérifie plusieurs URL — les doublons ne sont vérifiés qu'une fois. */
  checkMany(urls: readonly string[]): Promise<ProbeResult[]>;
  /** Récupère un corps texte borné — robots.txt, page de mentions légales. */
  fetchText(url: string, maxBytes?: number): Promise<{ result: ProbeResult; body: string | null }>;
  /** Requêtes encore disponibles ici. */
  readonly remaining: number;
  /** Vue à quota propre pour un critère — voir `CHECK_QUOTAS`. */
  forCheck(checkId: string): NetworkProbe;
}

/**
 * Quotas de requêtes par critère, pour UNE analyse de page.
 *
 * Les valeurs suivent ce que chaque critère a réellement à vérifier : beaucoup
 * de liens, moins d'images, une poignée d'adresses pour les mentions légales,
 * une pour le robots.txt. Un critère absent de cette table n'a pas vocation à
 * sortir sur le réseau ; il garde de quoi le faire, mais peu.
 */
export const CHECK_QUOTAS: Readonly<Record<string, number>> = {
  BROKEN_LINKS: 160,
  IMAGES: 80,
  MENTIONS_LEGALES: 10,
  ROBOTS_META: 4,
  /** Les feuilles de style d'une page : une charte, parfois deux ou trois. */
  CONTRAST_V2: 8,
};

/** Quota d'un critère qui n'en déclare pas. */
export const DEFAULT_CHECK_QUOTA = 6;

/**
 * Plafond ABSOLU d'une analyse, tous critères confondus.
 *
 * Il ne sert pas à répartir — les quotas s'en chargent — mais à garantir qu'une
 * page hostile ne puisse pas faire du serveur un amplificateur, quel que soit
 * le nombre de critères actifs.
 */
export const DEFAULT_REQUEST_BUDGET = 300;

/** Requêtes simultanées lancées par un même appel `checkMany`. */
export const DEFAULT_POOL_SIZE = 5;

/** Plafond par défaut d'un corps texte lu par un analyseur. */
const DEFAULT_TEXT_BYTES = 512 * 1024;

/**
 * Porte-monnaie : ce qui autorise — ou non — une requête réelle.
 *
 * Une requête servie par le cache ou par une requête déjà en vol n'a rien
 * coûté : elle est REMBOURSÉE. C'est ce qui permet au menu et au pied de page,
 * identiques sur tout un site, de ne peser sur le quota que la première fois.
 */
interface Wallet {
  take(): boolean;
  refund(): void;
  readonly remaining: number;
}

class BudgetWallet implements Wallet {
  constructor(private budget: number) {}

  get remaining(): number {
    return this.budget;
  }

  take(): boolean {
    if (this.budget <= 0) return false;
    this.budget -= 1;
    return true;
  }

  refund(): void {
    this.budget += 1;
  }
}

/** Quota d'un critère, adossé au plafond de l'analyse. */
class CheckWallet implements Wallet {
  constructor(
    private quota: number,
    private readonly parent: Wallet,
  ) {}

  get remaining(): number {
    return Math.min(this.quota, this.parent.remaining);
  }

  take(): boolean {
    if (this.quota <= 0) return false;
    if (!this.parent.take()) return false;
    this.quota -= 1;
    return true;
  }

  refund(): void {
    this.quota += 1;
    this.parent.refund();
  }
}

export interface AnalysisProbeOptions {
  /** Plafond absolu de l'analyse. */
  budget?: number;
  /** Requêtes simultanées par appel `checkMany`. */
  poolSize?: number;
}

/**
 * Sonde d'une analyse : un moteur, un plafond, et des vues par critère.
 *
 * L'orchestrateur en donne une VUE à chaque analyseur (`forCheck`) plutôt que
 * la sonde elle-même : c'est cette vue qui porte le quota du critère.
 */
export class AnalysisProbe implements NetworkProbe {
  private readonly views = new Map<string, NetworkProbe>();
  private readonly probe: BudgetedProbe;
  private readonly wallet: Wallet;

  constructor(
    private readonly engine: ProbeEngine,
    private readonly options: AnalysisProbeOptions = {},
  ) {
    this.wallet = new BudgetWallet(options.budget ?? DEFAULT_REQUEST_BUDGET);
    this.probe = new BudgetedProbe(engine, this.wallet, options.poolSize ?? DEFAULT_POOL_SIZE);
  }

  get remaining(): number {
    return this.wallet.remaining;
  }

  forCheck(checkId: string): NetworkProbe {
    const existing = this.views.get(checkId);
    if (existing) return existing;

    const quota = CHECK_QUOTAS[checkId] ?? DEFAULT_CHECK_QUOTA;
    const view = new BudgetedProbe(
      this.engine,
      new CheckWallet(quota, this.wallet),
      this.options.poolSize ?? DEFAULT_POOL_SIZE,
    );
    this.views.set(checkId, view);
    return view;
  }

  check(url: string): Promise<ProbeResult> {
    return this.probe.check(url);
  }

  checkMany(urls: readonly string[]): Promise<ProbeResult[]> {
    return this.probe.checkMany(urls);
  }

  fetchText(url: string, maxBytes?: number): Promise<{ result: ProbeResult; body: string | null }> {
    return this.probe.fetchText(url, maxBytes);
  }
}

/** Sonde adossée à un porte-monnaie — celui de l'analyse ou celui d'un critère. */
class BudgetedProbe implements NetworkProbe {
  constructor(
    private readonly engine: ProbeEngine,
    private readonly wallet: Wallet,
    private readonly poolSize: number,
  ) {}

  get remaining(): number {
    return this.wallet.remaining;
  }

  /** Une vue de critère est déjà la vue de son critère. */
  forCheck(): NetworkProbe {
    return this;
  }

  async check(url: string): Promise<ProbeResult> {
    if (!this.wallet.take()) return exhausted(url);

    const { result, billable } = await this.engine.resolve(url);
    if (!billable) this.wallet.refund();
    return result;
  }

  /**
   * Pool CONTINU sur les URL DISTINCTES.
   *
   * Une page cite le même lien de navigation des dizaines de fois : vérifier la
   * liste telle quelle dépenserait autant de requêtes. Les doublons sont donc
   * résolus une seule fois, puis redistribués dans l'ordre demandé — l'ordre
   * compte, un rapport qui attribue le statut d'une URL à une autre est pire
   * qu'un rapport absent.
   */
  async checkMany(urls: readonly string[]): Promise<ProbeResult[]> {
    if (urls.length === 0) return [];

    const distinct = [...new Set(urls)];
    const byUrl = new Map<string, ProbeResult>();
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < distinct.length) {
        const url = distinct[next++];
        if (url === undefined) continue;
        byUrl.set(url, await this.check(url));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.poolSize, distinct.length) }, () => worker()),
    );

    return urls.map(url => byUrl.get(url) ?? exhausted(url));
  }

  async fetchText(
    url: string,
    maxBytes = DEFAULT_TEXT_BYTES,
  ): Promise<{ result: ProbeResult; body: string | null }> {
    if (!this.wallet.take()) return { result: exhausted(url), body: null };

    const { result, body, billable } = await this.engine.text(url, maxBytes);
    if (!billable) this.wallet.refund();
    return { result, body };
  }
}

function exhausted(url: string): ProbeResult {
  return {
    url,
    status: null,
    ok: false,
    redirected: false,
    finalUrl: url,
    contentLength: null,
    contentType: null,
    exhausted: true,
    error: 'Quota de vérifications atteint pour ce critère',
  };
}
