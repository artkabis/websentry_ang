import type { CheckItem, CheckResult } from '@websentry/shared';
import type { EffectiveSettings } from './effective-settings.js';
import type { NetworkProbe } from './network-probe.js';
import type { HtmlPage } from './page.model.js';

/**
 * Socle commun des analyseurs.
 *
 * Un analyseur est une fonction PURE d'une page et de réglages vers un
 * résultat : pas d'accès à la base, pas d'état partagé, pas d'injection Nest.
 * C'est ce qui permet de l'exécuter dans un worker sans rien transporter
 * d'autre que du JSON — et de le tester sans monter quoi que ce soit.
 */
export abstract class BaseAnalyzer {
  /** Identifiant stable, référencé par le registre partagé et les réglages. */
  abstract readonly id: string;
  abstract readonly title: string;

  /**
   * `net` n'est fourni qu'aux critères qui vérifient des ressources distantes.
   * Il peut manquer — repli en ligne sans configuration de sortie, test
   * unitaire d'un critère purement DOM — et un analyseur qui en dépend doit
   * alors le DIRE dans son rapport plutôt que de conclure à tort qu'une
   * ressource est saine.
   */
  abstract analyze(
    page: HtmlPage,
    settings: EffectiveSettings,
    net?: NetworkProbe,
  ): Promise<CheckResult>;

  protected pass(items: CheckItem[], summary: string, score = 5): CheckResult {
    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: score,
      status: 'pass',
      items,
      summary,
      recommendations: [],
    };
  }

  protected warn(
    items: CheckItem[],
    summary: string,
    recommendations: string[],
    score = 3,
  ): CheckResult {
    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: score,
      status: 'warning',
      items,
      summary,
      recommendations,
    };
  }

  protected fail(
    items: CheckItem[],
    summary: string,
    recommendations: string[],
    score = 0,
  ): CheckResult {
    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: score,
      status: 'fail',
      items,
      summary,
      recommendations,
    };
  }

  /**
   * Critère non applicable.
   *
   * Le score est 5 et NON 0 : « non applicable » n'est pas un échec. Le noter
   * zéro ferait chuter la moyenne d'un site simplement parce qu'il n'a pas de
   * boutique, ou qu'un critère est désactivé pour lui.
   */
  protected na(summary = 'Non applicable'): CheckResult {
    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: 5,
      status: 'na',
      items: [],
      summary,
      recommendations: [],
    };
  }

  /**
   * Le critère est-il actif pour cette page ?
   *
   * `disabledChecks` l'emporte sur `enabledChecks` : c'est la liste qu'alimente
   * une règle par page, et une exception doit pouvoir désactiver un critère
   * qu'un profil a explicitement activé.
   */
  protected isEnabled(settings: EffectiveSettings): boolean {
    if (settings.disabledChecks?.includes(this.id)) return false;
    return !settings.enabledChecks || settings.enabledChecks.includes(this.id);
  }

  /** Extrait de source d'un élément, borné — alimente la vue « code ». */
  protected sourceOf(html: string | null | undefined, max = 500): string | undefined {
    if (!html) return undefined;
    const trimmed = html.trim().replace(/\s+/g, ' ');
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  }
}
