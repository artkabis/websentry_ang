import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Données connectées de l'éditeur.
 *
 * Un site d'éditeur tire ses coordonnées d'un gestionnaire de contenu central :
 * changer le numéro à un endroit le change partout. Un champ saisi « en dur »
 * fonctionne le jour même et devient faux au premier déménagement — c'est ce
 * décrochage que le critère cherche, pas une erreur visible.
 */

interface Binding {
  bindingName: string;
  value: string;
}

/** Valeurs d'attribut qui signifient « pas de liaison ». */
const INACTIVE_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'null']);

/** Jours de la semaine, tels que l'éditeur les numérote. */
const DAY_NAMES: Record<string, string> = {
  '0': 'Lun',
  '1': 'Mar',
  '2': 'Mer',
  '3': 'Jeu',
  '4': 'Ven',
  '5': 'Sam',
  '6': 'Dim',
};

/** Au-delà, le texte d'un widget n'est plus un résumé d'horaires. */
const MAX_HOURS_TEXT = 300;
/** Nombre d'exemples cités dans un détail. */
const MAX_LISTED = 5;

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export class DataBindingAnalyzer extends BaseAnalyzer {
  readonly id = 'DATA_BINDING';
  readonly title = 'Données connectées (Duda)';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());
    if (page.platform !== 'duda') {
      return Promise.resolve(this.na('Critère applicable aux seuls sites de l’éditeur.'));
    }

    const items: CheckItem[] = [];
    const recommendations: string[] = [];

    const footer = this.judgeFooterAddress(page, items, recommendations);
    const fields = this.judgeFields(page, items, recommendations);
    const bindings = this.judgeBindings(page, items, recommendations);
    const contacts = this.judgeContactButtons(page, items);
    this.judgeComponents(page, contacts, items, recommendations);
    this.judgeConfig(page, items);

    const warnings = items.filter(item => item.status === 'warning').length;

    return Promise.resolve({
      checkId: this.id,
      checkTitle: this.title,
      // Aucun échec possible : une liaison manquante se répare en un clic dans
      // l'éditeur, elle ne casse pas la page.
      globalScore: warnings >= 3 ? 2 : warnings === 2 ? 3 : warnings === 1 ? 4 : 5,
      status: warnings > 0 ? 'warning' : 'pass',
      items,
      summary:
        `${fields.total} champ(s) nommé(s), ${bindings.active}/${bindings.total} liaison(s) active(s), ` +
        `${fields.empty.length + bindings.empty.length} liaison(s) vide(s).` +
        (footer.addresses > 0 || footer.agencies > 0
          ? ` Pied de page : ${footer.addresses} adresse(s), ${footer.agencies} agence(s).`
          : ''),
      recommendations,
    });
  }

  /**
   * Adresse connectée dans le pied de page.
   *
   * L'éditeur nomme rarement ses clés : quand le nom ne dit rien, on se rabat
   * sur le TEXTE rendu, en y cherchant un code postal français. Un champ lié
   * dont le texte contient une adresse est une adresse connectée, quel que soit
   * le nom de sa clé.
   */
  private judgeFooterAddress(
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): { addresses: number; agencies: number } {
    const { $ } = page;
    const footer = $('.dmFooterContainer');
    const found = { addresses: 0, agencies: 0, byPostalCode: 0 };
    const addressKeys: string[] = [];
    const agencyKeys: string[] = [];
    const texts: string[] = [];
    // L'éditeur imbrique plusieurs éléments portant la MÊME liaison : sans
    // déduplication, une seule adresse serait comptée trois fois.
    const seenKeys = new Set<string>();
    const seenTexts = new Set<string>();

    footer
      .find('[data-binding], [data-inline-binding], [data-inline-binding-encoded]')
      .each((_, element) => {
        const node = $(element);
        const text = node.text().replace(/\s+/g, ' ').trim();
        let namedMatch = false;
        let hasBinding = false;

        for (const key of bindingKeysOf(node)) {
          hasBinding = true;
          const lowered = key.toLowerCase();
          const isAddress = lowered.includes('adresse');
          const isAgency = lowered.includes('agence');
          if (isAddress || isAgency) namedMatch = true;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          if (isAddress) {
            found.addresses += 1;
            addressKeys.push(key);
            if (text) texts.push(text);
          } else if (isAgency) {
            found.agencies += 1;
            agencyKeys.push(key);
            if (text) texts.push(text);
          }
        }

        if (namedMatch || !hasBinding || !text) return;
        if (!hasFrenchPostalCode(text) || seenTexts.has(text)) return;

        seenTexts.add(text);
        found.addresses += 1;
        found.byPostalCode += 1;
        addressKeys.push('code postal détecté');
        texts.push(text);
      });

    const details: string[] = [];
    if (addressKeys.length > 0) details.push(`Clés : ${addressKeys.join(' | ')}`);
    if (agencyKeys.length > 0) details.push(`Agences : ${agencyKeys.join(' | ')}`);
    if (found.byPostalCode > 0) {
      details.push(`${found.byPostalCode} adresse(s) reconnue(s) par leur code postal`);
    }

    const present = found.addresses > 0 || found.agencies > 0;
    items.push({
      key: 'DATA_BINDING.footer_address',
      label: present
        ? `Connecté dans le pied de page : ${[
            found.addresses > 0 ? `${found.addresses} adresse(s)` : '',
            found.agencies > 0 ? `${found.agencies} agence(s)` : '',
          ]
            .filter(Boolean)
            .join(', ')}`
        : 'Aucune adresse ni agence connectée dans le pied de page',
      status: present ? 'pass' : 'warning',
      ...(texts.length > 0 ? { value: texts.join(' | ') } : {}),
      ...(details.length > 0 ? { detail: details.join(' / ') } : {}),
    });

    if (!present) {
      recommendations.push(
        'Connecter l’adresse ou l’agence du pied de page au gestionnaire de contenu : saisie en dur, elle devient fausse au premier déménagement.',
      );
    }

    return found;
  }

  private judgeFields(
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): { total: number; empty: string[] } {
    const { $ } = page;
    const fields = $('[data-field]');
    const empty: string[] = [];

    fields.each((_, element) => {
      if ($(element).text().trim()) return;
      empty.push($(element).attr('data-field') || '(champ sans nom)');
    });

    if (fields.length === 0) {
      items.push({
        key: 'DATA_BINDING.no_data_field',
        label: 'Aucun champ connecté déclaré',
        status: 'warning',
      });
      recommendations.push(
        'Relier les éléments textuels (téléphone, e-mail, adresse) aux champs du gestionnaire de contenu.',
      );
    } else {
      items.push({
        key: 'DATA_BINDING.data_field_count',
        label: `${fields.length} champ(s) connecté(s) déclaré(s)`,
        status: 'pass',
      });
    }

    if (empty.length > 0) {
      items.push({
        key: 'DATA_BINDING.empty_data_field',
        label: `${empty.length} champ(s) connecté(s) vide(s)`,
        status: 'warning',
        detail: `Champs : ${empty.slice(0, MAX_LISTED).join(', ')}`,
      });
      recommendations.push(
        `${empty.length} champ(s) connecté(s) n'affichent rien : vérifier leur contenu dans le gestionnaire.`,
      );
    }

    return { total: fields.length, empty };
  }

  private judgeBindings(
    page: HtmlPage,
    items: CheckItem[],
    recommendations: string[],
  ): { total: number; active: number; empty: string[] } {
    const { $ } = page;
    const elements = $('[data-binding]');
    const empty: string[] = [];
    const byName: Record<string, number> = {};
    let active = 0;
    let opaque = 0;

    elements.each((_, element) => {
      const node = $(element);
      const raw = node.attr('data-binding') ?? '';

      if (!raw || INACTIVE_VALUES.has(raw)) {
        empty.push(`<${String(node.prop('tagName') ?? 'el').toLowerCase()}>`);
        return;
      }

      active += 1;
      const bindings = parseBindings(raw);
      if (bindings.length === 0) {
        // Liaison active mais illisible : elle compte comme active, ce qu'elle
        // est, sans qu'on prétende savoir à quoi elle relie.
        opaque += 1;
        return;
      }
      for (const binding of bindings) {
        const name = binding.bindingName || 'inconnu';
        byName[name] = (byName[name] ?? 0) + 1;
      }
    });

    const summary = Object.entries(byName)
      .sort(([, a], [, b]) => b - a)
      .map(([name, count]) => `${name} ×${count}`);
    if (opaque > 0) summary.push(`non décodé ×${opaque}`);

    if (elements.length === 0) {
      items.push({
        key: 'DATA_BINDING.no_data_binding',
        label: 'Aucun champ connecté actif',
        status: 'warning',
      });
      recommendations.push(
        'Aucune liaison détectée : si le site utilise le gestionnaire de contenu, ses connexions ne sont pas en place.',
      );
    } else {
      items.push({
        key: 'DATA_BINDING.data_binding_count',
        label: `${active} champ(s) connecté(s) actif(s) sur ${elements.length}`,
        status: active > 0 ? 'pass' : 'warning',
        ...(summary.length > 0 ? { detail: `Liaisons : ${summary.join(', ')}` } : {}),
      });
    }

    if (empty.length > 0) {
      items.push({
        key: 'DATA_BINDING.data_binding_empty',
        label: `${empty.length} champ(s) connecté(s) sans valeur active`,
        status: 'warning',
        detail: `Éléments : ${empty.slice(0, MAX_LISTED).join(', ')}`,
      });
      recommendations.push(
        `${empty.length} liaison(s) sont inactives : ces champs ne suivent plus le gestionnaire de contenu.`,
      );
    }

    return { total: elements.length, active, empty };
  }

  private judgeContactButtons(page: HtmlPage, items: CheckItem[]): { emails: string[] } {
    const { $ } = page;

    const callButtons = $('[data-element-type="clicktocall"]');
    const phones = unique(callButtons.toArray().map(element => phoneOf($, $(element))));
    items.push({
      key: 'DATA_BINDING.ctc_count',
      label: `${callButtons.length} bouton(s) d'appel`,
      status: 'pass',
      ...(phones.length > 0 ? { value: phones.join(', ') } : {}),
    });

    const mailButtons = $(
      '[data-element-type="clicktomail"], [data-element-type="emailextension"]',
    );
    const emails = unique(
      mailButtons.toArray().map(element => {
        const node = $(element);
        const href = node.attr('href')?.startsWith('mailto:')
          ? (node.attr('href') ?? '')
          : (node.closest('a[href^="mailto:"]').attr('href') ?? '');
        return href ? (href.slice('mailto:'.length).split('?')[0] ?? '').trim() : '';
      }),
    );
    items.push({
      key: 'DATA_BINDING.ctm_count',
      label: `${mailButtons.length} bouton(s) de courriel`,
      status: 'pass',
      ...(emails.length > 0 ? { value: emails.join(', ') } : {}),
    });

    return { emails };
  }

  private judgeComponents(
    page: HtmlPage,
    contacts: { emails: string[] },
    items: CheckItem[],
    recommendations: string[],
  ): void {
    this.judgeLogo(page, items, recommendations);
    this.judgeCallLinks(page, items, recommendations);
    this.judgeMap(page, items, recommendations);
    this.judgeHours(page, items, recommendations);
    this.judgeSocial(page, items, recommendations);
    this.judgeForm(page, contacts, items, recommendations);
  }

  private judgeLogo(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const logo = $(
      '[data-widget-type="logo"] [data-binding], .dmLogo [data-binding], [class*="hfcontainer"] [data-binding][data-widget-type="image"], .dmHeaderContainer [data-binding][data-widget-type="image"]',
    ).first();

    if (logo.length === 0) {
      items.push({
        key: 'DATA_BINDING.logo_connected',
        label: 'Logo : aucune liaison trouvée',
        status: 'warning',
      });
      recommendations.push('Connecter le logo au gestionnaire de contenu.');
      return;
    }

    const bindings = parseBindings(logo.attr('data-binding') ?? '');
    const image = bindings.find(binding => binding.bindingName === 'image');

    items.push({
      key: 'DATA_BINDING.logo_connected',
      label: image ? 'Logo connecté au gestionnaire de contenu' : 'Logo non connecté',
      status: image ? 'pass' : 'warning',
      ...(image?.value ? { value: image.value } : {}),
      ...(!image && bindings[0] ? { detail: `Liaison actuelle : ${bindings[0].bindingName}` } : {}),
    });

    if (!image) recommendations.push('Le logo n’est lié à aucune image du gestionnaire.');
  }

  private judgeCallLinks(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const links = $('.dmCall');
    if (links.length === 0) return;

    const connected = links
      .toArray()
      .filter(element =>
        parseBindings($(element).attr('data-binding') ?? '').some(
          binding => binding.bindingName === 'phone',
        ),
      ).length;
    const phones = unique(links.toArray().map(element => phoneOf($, $(element))));

    items.push({
      key: 'DATA_BINDING.ctc_connected',
      label:
        connected === links.length
          ? `${links.length} lien(s) d'appel connecté(s)`
          : `${connected}/${links.length} lien(s) d'appel connecté(s)`,
      status: connected === links.length ? 'pass' : 'warning',
      ...(phones.length > 0 ? { value: phones.join(', ') } : {}),
    });

    if (connected < links.length) {
      recommendations.push(
        `${links.length - connected} lien(s) d'appel affichent un numéro saisi en dur.`,
      );
    }
  }

  private judgeMap(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const map = $('.inlineMap').first();
    if (map.length === 0) return;

    const bindings = parseBindings(map.attr('data-binding') ?? '');
    const address = bindings.find(binding => binding.bindingName === 'address');
    const value = mapAddressOf($, map) || address?.value;

    items.push({
      key: 'DATA_BINDING.map_connected',
      label: address ? 'Carte connectée à l’adresse' : 'Carte non connectée à l’adresse',
      status: address ? 'pass' : 'warning',
      ...(value ? { value } : {}),
    });

    if (!address) recommendations.push('La carte n’est pas liée à l’adresse du gestionnaire.');
  }

  private judgeHours(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const widget = $('[data-element-type="open_hours"]').first();
    if (widget.length === 0) return;

    const connected = parseBindings(widget.attr('data-binding') ?? '').length > 0;
    const value = hoursOf($, widget);

    items.push({
      key: 'DATA_BINDING.hours_connected',
      label: connected ? 'Horaires connectés au gestionnaire' : 'Horaires non connectés',
      status: connected ? 'pass' : 'warning',
      ...(value ? { value } : {}),
    });

    if (!connected) {
      recommendations.push(
        'Les horaires sont saisis en dur : les connecter évite qu’ils restent faux après un changement.',
      );
    }
  }

  private judgeSocial(page: HtmlPage, items: CheckItem[], recommendations: string[]): void {
    const { $ } = page;
    const hubs = $('.dmSocialHub');
    if (hubs.length === 0) return;

    const connected = parseBindings(hubs.first().attr('data-binding') ?? '').some(
      binding => binding.bindingName === 'social',
    );

    const profiles = unique(
      hubs
        .find('a[href]')
        .toArray()
        .map(element => $(element).attr('href')?.trim() ?? '')
        .filter(href => href && !href.startsWith('#') && !href.startsWith('javascript')),
    ).map(hostnameOf);

    items.push({
      key: 'DATA_BINDING.social_connected',
      label: connected ? 'Réseaux sociaux connectés' : 'Réseaux sociaux non connectés',
      status: connected ? 'pass' : 'warning',
      ...(profiles.length > 0 ? { value: profiles.join(', ') } : {}),
    });

    if (!connected) recommendations.push('Le bloc réseaux sociaux n’est pas lié au gestionnaire.');
  }

  private judgeForm(
    page: HtmlPage,
    contacts: { emails: string[] },
    items: CheckItem[],
    recommendations: string[],
  ): void {
    const { $ } = page;
    const form = $('.dmform').first();
    if (form.length === 0) return;

    const connected = parseBindings(form.attr('data-binding') ?? '').some(
      binding => binding.bindingName === 'email',
    );

    const recipients: string[] = [];
    let opaqueRecipient = false;

    form.find('[name="dmformsendto"]').each((_, element) => {
      const raw = $(element).attr('value') ?? '';
      if (!raw) return;
      const parts = raw.split(',').map(part => part.trim());
      if (parts.every(part => EMAIL_PATTERN.test(part))) recipients.push(...parts);
      // Une valeur illisible est un jeton chiffré côté éditeur, pas une erreur
      // de configuration : la signaler comme telle serait un faux positif.
      else opaqueRecipient = true;
    });

    const value = unique(recipients).join(', ') || fallbackFormEmail($, form, contacts.emails);
    const encrypted = opaqueRecipient && recipients.length === 0;

    items.push({
      key: 'DATA_BINDING.form_connected',
      label: connected
        ? 'Formulaire connecté à l’adresse du gestionnaire'
        : encrypted
          ? 'Formulaire : destinataire chiffré (non analysable)'
          : 'Formulaire non connecté à une adresse',
      status: connected ? 'pass' : encrypted ? 'info' : 'warning',
      ...(value ? { value } : {}),
      ...(encrypted
        ? { detail: 'Le destinataire est un jeton chiffré, illisible depuis la page.' }
        : {}),
    });

    if (!connected && !encrypted) {
      recommendations.push('Le formulaire n’est pas lié à l’adresse du gestionnaire.');
    }
  }

  private judgeConfig(page: HtmlPage, items: CheckItem[]): void {
    const { $ } = page;
    const scripts = $('script:not([src])')
      .toArray()
      .map(element => $(element).html() ?? '')
      .join('\n');

    const detected =
      scripts.includes('dmAPI') ||
      scripts.includes('window.__DUDA__') ||
      scripts.includes('__DudaOne__');

    items.push({
      key: 'DATA_BINDING.duda_config',
      label: detected ? 'Configuration de l’éditeur détectée' : 'Configuration non détectée',
      // Purement informatif : son absence ne dit rien de la qualité du site.
      status: 'pass',
    });
  }
}

/** Clés de liaison portées par un élément, toutes formes confondues. */
function bindingKeysOf(node: Selection): string[] {
  const keys: string[] = [];

  const inline = node.attr('data-inline-binding');
  if (inline) keys.push(inline);

  const encoded = decodeBase64(node.attr('data-inline-binding-encoded') ?? '');
  if (encoded) keys.push(encoded);

  for (const binding of parseBindings(node.attr('data-binding') ?? '')) {
    if (binding.value) keys.push(binding.value);
  }

  return keys;
}

function parseBindings(raw: string): Binding[] {
  const decoded = decodeBase64(raw);
  if (!decoded) return [];

  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
      )
      .map(entry => ({
        bindingName: typeof entry['bindingName'] === 'string' ? entry['bindingName'] : '',
        value: typeof entry['value'] === 'string' ? entry['value'] : '',
      }));
  } catch {
    return [];
  }
}

/** Heuristique : une valeur trop courte ou hors alphabet n'est pas du base64. */
function decodeBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Un code postal français dans un texte.
 *
 * Trois garde-fous contre les faux positifs : exactement cinq chiffres isolés
 * (un numéro de téléphone ou un SIRET en ont davantage), suivis d'un nom de
 * ville en majuscule (ce qui écarte « au capital de 12500 euros »), et un
 * département plausible.
 */
function hasFrenchPostalCode(text: string): boolean {
  const pattern = /(?<!\d)(\d{5})(?!\d)(?:\s*,?\s*)\p{Lu}/gu;
  const normalized = text.replace(/\s+/g, ' ');

  for (const match of normalized.matchAll(pattern)) {
    const code = match[1] ?? '';
    const department = Number(code.slice(0, 2));
    if ((department >= 1 && department <= 95) || code.startsWith('97') || code.startsWith('98')) {
      return true;
    }
  }

  return false;
}

/** Numéro d'un bouton d'appel : attribut, texte visible, puis lien `tel:`. */
function phoneOf($: HtmlPage['$'], node: Selection): string {
  const attribute = node.attr('phone')?.trim();
  if (attribute) return attribute;

  const visible = node.find('.phoneNumHolder').first().text().trim();
  if (visible) return visible;

  const href = node.attr('href')?.startsWith('tel:')
    ? (node.attr('href') ?? '')
    : (node.closest('a[href^="tel:"]').attr('href') ?? '');
  return href ? href.slice('tel:'.length).trim() : '';
}

/**
 * Adresse affichée par une carte.
 *
 * La v1 enchaînait deux recherches avec `||` : une sélection Cheerio VIDE
 * restant un objet, donc toujours vraie, la seconde n'était jamais évaluée. On
 * teste ici la longueur.
 */
function mapAddressOf($: HtmlPage['$'], map: Selection): string {
  const declared = map.attr('addresstodisplay')?.trim();
  if (declared && declared.length > 3) return declared;

  const inContainer = map.closest('[class*="map" i]').find('[data-field]').first();
  if (inContainer.length > 0) {
    const text = inContainer.text().trim();
    if (text) return text;
  }

  const nearby = map.parent().find('[data-field*="address"], [class*="address"]').first();
  if (nearby.length > 0) {
    const text = nearby.text().trim();
    if (text) return text;
  }

  return map.attr('data-address')?.trim() ?? '';
}

/** Horaires : structure rendue, données encodées, puis texte visible. */
function hoursOf($: HtmlPage['$'], widget: Selection): string {
  const lines: string[] = [];

  widget.find('.open-hours-item').each((_, item) => {
    const node = $(item);
    const times = node
      .find('time')
      .toArray()
      .map(time => $(time).text().trim())
      .filter(Boolean);
    if (times.length === 0) return;

    const label = node.find('dt').first();
    const day = label.text().trim() || DAY_NAMES[label.attr('day') ?? ''] || '';
    lines.push(
      times.length >= 2
        ? `${day} ${times[0]}–${times[times.length - 1]}`.trim()
        : `${day} ${times[0]}`.trim(),
    );
  });

  if (lines.length > 0) return lines.join(' | ');

  const encoded = decodeBase64(widget.attr('hours_data') ?? widget.attr('data-hours-data') ?? '');
  if (encoded) {
    const parsed = parseHours(encoded);
    if (parsed) return parsed;
  }

  const text = widget.text().replace(/\s+/g, ' ').trim();
  return text.length > 0 && text.length < MAX_HOURS_TEXT ? text : '';
}

function parseHours(decoded: string): string | null {
  interface Slot {
    day?: string;
    open?: string;
    close?: string;
    closed?: boolean;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  const slots: Array<[string, Slot]> = Array.isArray(parsed)
    ? (parsed as Slot[]).map(slot => [String(slot.day ?? ''), slot])
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed as Record<string, Slot>)
      : [];

  const lines = slots
    .filter(([, slot]) => !slot.closed && slot.open && slot.close)
    .map(([day, slot]) => `${DAY_NAMES[day] ?? day} ${slot.open}–${slot.close}`.trim())
    .slice(0, 7);

  return lines.length > 0 ? lines.join(' | ') : null;
}

/** Destinataire d'un formulaire, à défaut de liaison : `mailto:`, action, puis bouton. */
function fallbackFormEmail($: HtmlPage['$'], form: Selection, fromButtons: string[]): string {
  const mailto =
    form.find('a[href^="mailto:"]').first().attr('href') ??
    form.closest('a[href^="mailto:"]').attr('href') ??
    '';
  if (mailto) return (mailto.slice('mailto:'.length).split('?')[0] ?? '').trim();

  const action = form.attr('action') ?? '';
  if (action.startsWith('mailto:')) {
    return (action.slice('mailto:'.length).split('?')[0] ?? '').trim();
  }

  return fromButtons[0] ?? '';
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
