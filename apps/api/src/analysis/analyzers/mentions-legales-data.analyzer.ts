import type { CheckItem, CheckResult, CheckStatus } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage } from '../page.model.js';

/**
 * Mentions légales — champs du widget « données connectées ».
 *
 * L'éditeur stocke ces champs de deux façons selon les versions : la valeur
 * EMBARQUÉE dans une configuration base64, ou une LIAISON vers le gestionnaire
 * de contenu, dont la valeur se trouve ailleurs dans la page. Les deux sont
 * gérées, la première d'abord : elle porte les valeurs réelles.
 */

interface LegalField {
  name: string;
  label: string;
  mandatory: boolean;
}

/** Champs attendus — obligations de la loi pour la confiance dans l'économie numérique. */
const LEGAL_FIELDS: readonly LegalField[] = [
  { name: 'raisonsociale', label: 'Raison sociale', mandatory: true },
  { name: 'juridique', label: 'Forme juridique', mandatory: true },
  { name: 'capitalsocial', label: 'Capital social', mandatory: true },
  { name: 'adresse', label: 'Adresse', mandatory: true },
  { name: 'email', label: 'Adresse e-mail', mandatory: true },
  { name: 'telephone', label: 'Téléphone', mandatory: true },
  { name: 'rcs', label: 'N° RCS / Répertoire des métiers', mandatory: true },
  { name: 'siret', label: 'N° SIRET', mandatory: true },
  { name: 'tva', label: 'N° TVA intracommunautaire', mandatory: false },
  { name: 'directeur', label: 'Directeur de la publication', mandatory: true },
  { name: 'reglespro', label: 'Règles professionnelles applicables', mandatory: false },
  { name: 'titrepro', label: 'Titre professionnel', mandatory: false },
  { name: 'etat', label: 'État UE — titre professionnel', mandatory: false },
  { name: 'ordre', label: 'Ordre / organisme', mandatory: false },
  { name: 'specifique', label: 'Mentions légales spécifiques', mandatory: false },
  { name: 'champlibre', label: 'Champ libre — mention obligatoire', mandatory: false },
  { name: 'mediateur', label: 'Médiateur de la consommation', mandatory: false },
  { name: 'mentionsobligatoires', label: 'Mentions obligatoires', mandatory: false },
];

/** Champs qui identifient à coup sûr une configuration de mentions légales. */
const SIGNATURE_FIELDS = ['raisonsociale', 'directeur', 'juridique', 'siret'];

/** Chemins qui désignent la page de mentions légales. */
const LEGAL_PATHS = ['mentions-legales', 'mentions_legales', 'mentionslegales'];

/** Longueur au-delà de laquelle une valeur est tronquée dans le rapport. */
const MAX_VALUE_LENGTH = 80;

export class MentionsLegalesDataAnalyzer extends BaseAnalyzer {
  readonly id = 'MENTIONS_LEGALES_DATA';
  readonly title = 'Mentions légales — Données connectées';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());
    if (page.platform !== 'duda') {
      return Promise.resolve(this.na('Non applicable — site construit hors de l’éditeur.'));
    }
    if (!isLegalPage(page.url)) {
      return Promise.resolve(
        this.na('Non applicable — vérification effectuée sur la page de mentions légales.'),
      );
    }

    const embedded = findEmbeddedConfig(page);
    if (embedded) return Promise.resolve(this.judgeEmbedded(embedded));

    const bindings = findBindings(page);
    if (!bindings) return Promise.resolve(this.reportMissingWidget(page));

    return Promise.resolve(this.judgeBindings(page, bindings));
  }

  /** Mode « configuration embarquée » : les valeurs sont dans la page. */
  private judgeEmbedded(config: Record<string, unknown>): CheckResult {
    const items: CheckItem[] = [
      {
        key: 'ML_DATA.widget_found',
        label: 'Widget données connectées présent (configuration embarquée)',
        status: 'pass',
      },
    ];
    const recommendations: string[] = [];
    const siret = clean(config['siret']);

    for (const field of LEGAL_FIELDS) {
      const value = clean(config[field.name]);
      if (!value) {
        items.push(missingItem(field, 'Champ vide ou absent de la configuration du widget.'));
        if (field.mandatory) {
          recommendations.push(`Renseigner « ${field.label} » dans le widget.`);
        }
        continue;
      }
      items.push(...filledItem(field, value, siret, recommendations));
    }

    return this.conclude(items, recommendations);
  }

  /** Mode « liaison CMS » : la valeur vit ailleurs dans la page. */
  private judgeBindings(page: HtmlPage, bindings: Map<string, string>): CheckResult {
    const fields = indexDataFields(page);
    const items: CheckItem[] = [
      {
        key: 'ML_DATA.widget_found',
        label: `Widget données connectées présent (${bindings.size} liaison(s) CMS)`,
        status: 'pass',
      },
    ];
    const recommendations: string[] = [];
    const siret = resolveField(fields, bindings, 'siret');

    for (const field of LEGAL_FIELDS) {
      const key = bindings.get(field.name);

      if (!key) {
        items.push(missingItem(field, 'Liaison absente du widget.', 'liaison non configurée'));
        if (field.mandatory) {
          recommendations.push(`Configurer la liaison « ${field.label} » dans le widget.`);
        }
        continue;
      }

      const value = resolveField(fields, bindings, field.name);
      if (value === null) {
        // La liaison existe mais la valeur est rendue côté client : ni conforme
        // ni fautif — on le dit, sans peser sur la note.
        items.push({
          key: `ML_DATA.binding_${field.name}`,
          label: `${field.label} — liaison configurée, valeur non vérifiable statiquement`,
          status: 'info',
          detail: 'La valeur est injectée par le navigateur : la vérifier dans le CMS.',
        });
        continue;
      }

      if (!value) {
        items.push(missingItem(field, 'Champ vide dans le gestionnaire de contenu.'));
        if (field.mandatory) {
          recommendations.push(`Renseigner « ${field.label} » dans le gestionnaire de contenu.`);
        }
        continue;
      }

      items.push(...filledItem(field, value, siret ?? '', recommendations));
    }

    return this.conclude(items, recommendations);
  }

  private reportMissingWidget(page: HtmlPage): CheckResult {
    const present = page.$('[dmle_extension="custom_extension"]').length > 0;

    return this.fail(
      [
        {
          key: 'ML_DATA.widget_missing',
          label: present
            ? 'Widget données connectées présent mais non reconnu'
            : 'Widget données connectées absent',
          status: 'fail',
          detail: present
            ? 'Le widget est là mais ne porte aucune donnée légale reconnaissable.'
            : 'Aucun widget de données connectées sur la page.',
        },
      ],
      present
        ? 'Le widget est présent mais ses données légales ne sont pas reconnues.'
        : 'Le widget « Données connectées » est absent de la page de mentions légales.',
      ['Vérifier la configuration du widget de données légales sur la page de mentions légales.'],
    );
  }

  private conclude(items: CheckItem[], recommendations: string[]): CheckResult {
    const failures = items.filter(item => item.status === 'fail').length;
    const warnings = items.filter(item => item.status === 'warning').length;
    const filled = items.filter(item => item.status === 'pass').length;

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: failures >= 3 ? 0 : failures >= 1 ? 2 : warnings >= 5 ? 3 : warnings > 0 ? 4 : 5,
      status: failures > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      items,
      summary: `${filled} champ(s) renseigné(s) — ${failures} obligatoire(s) manquant(s), ${warnings} optionnel(s) vide(s).`,
      recommendations,
    };
  }
}

function missingItem(field: LegalField, detail: string, wording = 'non renseigné'): CheckItem {
  return {
    key: `ML_DATA.binding_${field.name}`,
    label: `${field.label} — ${wording}`,
    // Un champ optionnel vide n'est pas une faute : il est simplement sans
    // objet pour beaucoup d'activités.
    status: field.mandatory ? 'fail' : 'warning',
    detail,
  };
}

function filledItem(
  field: LegalField,
  value: string,
  siret: string,
  recommendations: string[],
): CheckItem[] {
  if (field.name !== 'rcs') {
    return [
      {
        key: `ML_DATA.binding_${field.name}`,
        label: `${field.label} — renseigné`,
        value: truncate(value),
        status: 'pass',
      },
    ];
  }

  const check = validateRcs(value, siret);
  if (check.status === 'warning') {
    recommendations.push('Vérifier le format du N° RCS : « RCS <ville> <SIREN à 9 chiffres> ».');
  }

  return [
    {
      key: 'ML_DATA.binding_rcs',
      label: check.label,
      value: truncate(value),
      status: check.status,
      detail: check.detail,
    },
  ];
}

function isLegalPage(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return LEGAL_PATHS.some(candidate => path.includes(candidate));
  } catch {
    return false;
  }
}

/** Configuration embarquée, en base64 ou en JSON brut selon la version. */
function findEmbeddedConfig(page: HtmlPage): Record<string, unknown> | null {
  const { $ } = page;

  for (const element of $('[data-widget-config]').toArray()) {
    const raw = $(element).attr('data-widget-config') ?? '';
    if (!raw) continue;

    const parsed = parseObject(decodeBase64(raw)) ?? parseObject(raw);
    if (!parsed) continue;

    // La configuration d'un widget quelconque ne doit pas être prise pour
    // celle des mentions légales : on exige un champ signature.
    if (SIGNATURE_FIELDS.some(field => field in parsed)) return parsed;
  }

  return null;
}

/** Liaisons CMS : `bindingName` → clé de contenu. */
function findBindings(page: HtmlPage): Map<string, string> | null {
  const { $ } = page;

  for (const element of $('[data-binding]').toArray()) {
    const decoded = decodeBase64($(element).attr('data-binding') ?? '');
    if (!decoded) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const bindings = new Map<string, string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { bindingName?: unknown; value?: unknown };
      if (typeof record.bindingName !== 'string' || typeof record.value !== 'string') continue;
      bindings.set(record.bindingName, stripPrefix(record.value));
    }

    if (bindings.has('raisonsociale') || bindings.has('directeur')) return bindings;
  }

  return null;
}

/**
 * Index des `data-field` de la page.
 *
 * Indexer une fois plutôt que construire un sélecteur par champ : la clé vient
 * d'une configuration base64 contenue dans la page ANALYSÉE, et un guillemet
 * dans cette valeur — que l'auteur de la page contrôle — casserait le sélecteur
 * et ferait tomber le critère entier.
 */
function indexDataFields(page: HtmlPage): Map<string, string> {
  const { $ } = page;
  const fields = new Map<string, string>();

  $('[data-field]').each((_, element) => {
    const name = $(element).attr('data-field');
    if (!name || fields.has(name)) return;
    fields.set(name, clean($(element).text()));
  });

  return fields;
}

/**
 * Valeur d'un champ lié.
 *
 * Trois clés sont tentées, de la plus précise à la plus générale : la clé
 * complète, son identifiant court, puis le nom de la liaison. `null` signifie
 * « aucun élément trouvé », ce qui n'est pas la même chose qu'une valeur vide.
 */
function resolveField(
  fields: Map<string, string>,
  bindings: Map<string, string>,
  name: string,
): string | null {
  const key = bindings.get(name);
  if (!key) return null;

  const candidates = [key, key.includes(' ') ? (key.split(' ')[0] ?? '') : '', name].filter(
    Boolean,
  );

  for (const candidate of candidates) {
    const value = fields.get(candidate);
    if (value !== undefined) return value;
  }

  return null;
}

function stripPrefix(value: string): string {
  return value.startsWith('site_text.') ? value.slice('site_text.'.length) : value;
}

function decodeBase64(value: string): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Retire le balisage, les entités et les gabarits laissés par l'éditeur.
 *
 * Seules les valeurs SCALAIRES sont retenues : une configuration de widget peut
 * porter un objet ou un tableau là où un texte est attendu, et le convertir en
 * chaîne produirait « [object Object] » — une valeur non vide, donc un champ
 * déclaré renseigné alors qu'il ne l'est pas.
 */
function clean(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';

  return (
    value
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      // Espace insécable, puis caractères de CONTRÔLE : l'éditeur laisse traîner
      // des octets nuls dans ses champs, et un champ qui n'en contient que ne
      // doit pas passer pour renseigné.
      .replace(/\u{00a0}/gu, ' ')
      .replace(/\p{Cc}/gu, '')
      .replace(/\[\[.*?\]\]/g, '')
      .trim()
  );
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH - 3)}…` : value;
}

interface RcsCheck {
  status: Extract<CheckStatus, 'pass' | 'warning'>;
  label: string;
  detail: string;
}

/**
 * Structure d'une mention RCS renseignée.
 *
 * Deux composants sont exigés — une ville de greffe et un SIREN — dans un ordre
 * quelconque. Le mot-clé « RCS » est facultatif : le champ le porte déjà dans
 * son intitulé, et les valeurs réelles l'omettent souvent. Une structure
 * douteuse vaut un AVERTISSEMENT et non un échec : la mention existe, seul son
 * format est à vérifier.
 */
function validateRcs(value: string, siret: string): RcsCheck {
  const problems: string[] = [];
  const keyword = /\b(RCS|RNE)\b/i.exec(value)?.[1]?.toUpperCase() ?? 'RCS';

  const siren = extractSiren(value);
  if (!siren) problems.push('numéro SIREN à 9 chiffres introuvable');

  const city = value
    .replace(/\b(RCS|RNE)\b/gi, ' ')
    .replace(/\d[\d ]*\d|\d/g, ' ')
    // Une lettre isolée est un code de greffe (A, B), pas une ville.
    .replace(/\b[A-Za-zÀ-ÿ]\b/g, ' ')
    .replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (city.length < 2) problems.push('ville de greffe absente');

  const sirenFromSiret = digitsOf(siret).length === 14 ? digitsOf(siret).slice(0, 9) : null;
  if (siren && sirenFromSiret && siren !== sirenFromSiret) {
    problems.push(
      `le SIREN du RCS (${siren}) ne correspond pas aux 9 premiers chiffres du SIRET (${sirenFromSiret})`,
    );
  }

  if (problems.length > 0) {
    return {
      status: 'warning',
      label: 'N° RCS / Répertoire des métiers — structure à vérifier',
      detail: `Mention renseignée mais non conforme : ${problems.join(' ; ')}.`,
    };
  }

  return {
    status: 'pass',
    label: 'N° RCS / Répertoire des métiers — structure valide',
    detail: sirenFromSiret
      ? `Mention ${keyword} conforme — SIREN ${siren} cohérent avec le SIRET.`
      : `Mention ${keyword} conforme — SIREN ${siren} (recoupement SIRET indisponible).`,
  };
}

/** SIREN à 9 chiffres, en tolérant les espaces de groupage. */
function extractSiren(value: string): string | null {
  for (const group of value.match(/\d[\d ]*\d|\d/g) ?? []) {
    const digits = digitsOf(group);
    if (digits.length === 9) return digits;
  }
  return null;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}
