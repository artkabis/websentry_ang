import {
  ANALYZERS_REGISTRY,
  resolveCheckWeight,
  type AnalysisReport,
  type CheckGroup,
  type CheckResult,
  type CheckStatus,
  type WeightAwareSettings,
} from '@websentry/shared';

/**
 * Modèle d'affichage du rapport — fonctions PURES.
 *
 * Le principe qui gouverne tout ce fichier : **montrer d'abord ce qui ne va
 * pas**. Un rapport de vingt-neuf lignes dont vingt-cinq sont vertes apprend à
 * l'équipe à le survoler ; quand elle le survole, elle rate aussi les quatre
 * rouges. La conformité n'est donc pas masquée — elle est résumée en un chiffre,
 * et dépliable.
 *
 * Trois niveaux de lecture :
 *   1. le verdict et les actions prioritaires — ce qu'on lit toujours ;
 *   2. les critères groupés par famille — ce qu'on parcourt ;
 *   3. le détail d'un critère — ce qu'on ouvre quand on corrige.
 */

// ── Niveau 1 : verdict ───────────────────────────────────────────────────────

export type VerdictTone = 'good' | 'warning' | 'critical' | 'unknown';

export interface Verdict {
  tone: VerdictTone;
  /** Titre court, affirmatif — ce que l'utilisateur retient. */
  headline: string;
  /** Une phrase qui dit quoi faire de ce score. */
  detail: string;
}

/** Seuils de l'échelle 0–5, identiques à ceux du backend et de l'historique. */
export const SCORE_GOOD = 4;
export const SCORE_WARNING = 3;

export function verdictOf(score: number, failing: number): Verdict {
  if (score >= SCORE_GOOD) {
    return {
      tone: 'good',
      headline: 'Page conforme',
      detail:
        failing === 0
          ? 'Aucun point bloquant détecté.'
          : `${failing} point(s) à surveiller, sans gravité immédiate.`,
    };
  }
  if (score >= SCORE_WARNING) {
    return {
      tone: 'warning',
      headline: 'Des corrections à prévoir',
      detail: `${failing} critère(s) en échec. La page reste exploitable, mais perd en qualité.`,
    };
  }
  return {
    tone: 'critical',
    headline: 'Corrections urgentes',
    detail: `${failing} critère(s) en échec, dont certains bloquent l’indexation ou la lisibilité.`,
  };
}

// ── Niveau 1 : actions prioritaires ──────────────────────────────────────────

export interface PriorityAction {
  checkId: string;
  checkTitle: string;
  /** La recommandation elle-même — une phrase actionnable. */
  action: string;
  status: CheckStatus;
  /** Poids du critère dans le score : dit COMBIEN la correction rapporte. */
  weight: number;
}

/** Au-delà, ce n'est plus une liste de priorités mais une seconde table des matières. */
export const MAX_PRIORITY_ACTIONS = 3;

/**
 * Les corrections les plus rentables, en tête de rapport.
 *
 * Le tri combine la GRAVITÉ (un échec avant un avertissement) et le POIDS du
 * critère dans le profil : corriger un critère en échec qui pèse double
 * rapporte plus que trois avertissements à poids nul. C'est précisément le
 * calcul que l'utilisateur ne peut pas faire de tête en lisant une liste plate.
 *
 * Les critères en mode indicatif (poids 0) sont ÉCARTÉS : ils n'entrent pas
 * dans le score, donc les corriger ne rapporte rien — les proposer en priorité
 * serait un mauvais conseil.
 */
export function priorityActions(
  report: AnalysisReport,
  settings?: WeightAwareSettings | null,
  limit = MAX_PRIORITY_ACTIONS,
): PriorityAction[] {
  const candidates: PriorityAction[] = [];

  for (const check of Object.values(report.checks)) {
    if (check.status !== 'fail' && check.status !== 'warning') continue;

    const weight = resolveCheckWeight(check.checkId, settings);
    if (weight <= 0) continue;

    const action = check.recommendations[0];
    if (!action) continue;

    candidates.push({
      checkId: check.checkId,
      checkTitle: check.checkTitle,
      action,
      status: check.status,
      weight,
    });
  }

  return candidates
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'fail' ? -1 : 1;
      if (a.weight !== b.weight) return b.weight - a.weight;
      // Ordre stable : deux rapports identiques doivent proposer les mêmes
      // priorités dans le même ordre.
      return a.checkId.localeCompare(b.checkId);
    })
    .slice(0, limit);
}

// ── Niveau 2 : groupes ───────────────────────────────────────────────────────

export interface StatusCounts {
  fail: number;
  warning: number;
  info: number;
  pass: number;
  na: number;
}

export function countStatuses(checks: readonly CheckResult[]): StatusCounts {
  const counts: StatusCounts = { fail: 0, warning: 0, info: 0, pass: 0, na: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

export interface CheckGroupView {
  group: CheckGroup;
  checks: CheckResult[];
  counts: StatusCounts;
  /** `true` dès qu'un critère du groupe demande une action. */
  needsAttention: boolean;
}

/** Ordre d'affichage : ce qui bloque l'indexation avant ce qui relève du confort. */
const GROUP_ORDER: readonly CheckGroup[] = ['SEO', 'Technique', 'Design'];

/** Gravité décroissante — pilote le tri des critères DANS un groupe. */
const STATUS_RANK: Readonly<Record<CheckStatus, number>> = {
  fail: 0,
  warning: 1,
  info: 2,
  pass: 3,
  na: 4,
};

const GROUP_BY_CHECK = new Map(ANALYZERS_REGISTRY.map(meta => [meta.id, meta.group]));

/**
 * Répartit les critères par famille, les plus graves en tête de chaque famille.
 *
 * Un groupe VIDE n'est pas rendu : afficher « Design — 0 critère » sur un
 * rapport partiel n'apprend rien et occupe la place de ce qui compte.
 */
export function groupChecks(report: AnalysisReport): CheckGroupView[] {
  const byGroup = new Map<CheckGroup, CheckResult[]>();

  for (const check of Object.values(report.checks)) {
    // Un critère absent du registre est rangé en « Technique » plutôt
    // qu'écarté : le perdre silencieusement priverait l'utilisateur d'un
    // résultat que le moteur a bel et bien produit.
    const group = GROUP_BY_CHECK.get(check.checkId) ?? 'Technique';
    const existing = byGroup.get(group) ?? [];
    existing.push(check);
    byGroup.set(group, existing);
  }

  return GROUP_ORDER.filter(group => (byGroup.get(group) ?? []).length > 0).map(group => {
    const checks = (byGroup.get(group) ?? []).sort(bySeverityThenTitle);
    const counts = countStatuses(checks);
    return {
      group,
      checks,
      counts,
      needsAttention: counts.fail > 0 || counts.warning > 0,
    };
  });
}

function bySeverityThenTitle(a: CheckResult, b: CheckResult): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return a.checkTitle.localeCompare(b.checkTitle, 'fr');
}

// ── Filtre d'affichage ───────────────────────────────────────────────────────

export type ReportFilter = 'attention' | 'all';

/**
 * Filtre par défaut : **ce qui demande une action**.
 *
 * C'est le choix central du remaniement. Un rapport qui s'ouvre sur vingt-neuf
 * lignes dont vingt-cinq vertes se survole ; un rapport qui s'ouvre sur les
 * quatre problèmes se lit. Le reste est à un clic, et son décompte reste
 * visible pour qu'on sache exactement ce qui est masqué.
 */
export const DEFAULT_FILTER: ReportFilter = 'attention';

export function applyFilter(checks: readonly CheckResult[], filter: ReportFilter): CheckResult[] {
  if (filter === 'all') return [...checks];
  return checks.filter(check => check.status === 'fail' || check.status === 'warning');
}

/** Nombre de critères que le filtre courant masque — jamais laissé implicite. */
export function hiddenCount(checks: readonly CheckResult[], filter: ReportFilter): number {
  return checks.length - applyFilter(checks, filter).length;
}

// ── Niveau 3 : détail d'un critère ───────────────────────────────────────────

/**
 * Lien « voir dans la page », construit sur un fragment de texte.
 *
 * Le navigateur surligne lui-même le passage : aucun script, aucune
 * dépendance au gabarit du site analysé. Un sélecteur CSS, lui, casserait au
 * premier changement de thème.
 *
 * Les composants du fragment sont encodés séparément : `-` et `,` y ont une
 * signification syntaxique, et les laisser passer bruts produirait un lien
 * silencieusement faux.
 */
export function locatorUrl(pageUrl: string, locator: CheckItemLocatorLike): string | null {
  const text = locator.text?.trim();
  if (!text) return null;

  const encode = (value: string) => encodeURIComponent(value).replace(/-/g, '%2D');

  let fragment = encode(text);
  if (locator.textEnd) fragment += `,${encode(locator.textEnd)}`;
  if (locator.prefix) fragment = `${encode(locator.prefix)}-,${fragment}`;
  if (locator.suffix) fragment += `,-${encode(locator.suffix)}`;

  return `${pageUrl}#:~:text=${fragment}`;
}

/** Ce dont `locatorUrl` a besoin — volontairement structurel, pour rester testable. */
export interface CheckItemLocatorLike {
  text?: string;
  textEnd?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Les items d'un critère, les plus graves d'abord.
 *
 * Un critère en échec peut porter quarante items dont deux fautifs : les
 * remonter évite de faire dérouler l'utilisateur jusqu'à ce qu'il abandonne.
 */
export function sortItems<T extends { status: CheckStatus }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
}
