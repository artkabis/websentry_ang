import type { CheckItem, CheckResult } from '@websentry/shared';
import { BaseAnalyzer } from '../base.analyzer.js';
import type { EffectiveSettings } from '../effective-settings.js';
import type { HtmlPage, Selection } from '../page.model.js';

/**
 * Structure de la navigation principale.
 *
 * Le critère ne s'applique qu'aux gabarits qui exposent un `#hcontainer` : il
 * vérifie une convention de construction, pas une règle universelle du web.
 * Ailleurs, il se déclare NON APPLICABLE plutôt que d'inventer un défaut.
 */

interface ExpectedPage {
  key: string;
  label: string;
  /** Fragments de chemin acceptés. */
  paths: string[];
  /** Libellés visibles acceptés, normalisés. */
  labels: string[];
}

const EXPECTED_PAGES: readonly ExpectedPage[] = [
  { key: 'home', label: 'Page d’accueil', paths: ['/'], labels: ['accueil', 'home'] },
  {
    key: 'about',
    label: 'Page À propos',
    paths: ['/a-propos', '/apropos', '/about', '/qui-sommes-nous', '/qui-nous-sommes'],
    labels: ['à propos', 'a propos', 'qui sommes-nous', 'qui nous sommes', 'about'],
  },
  {
    key: 'realisations',
    label: 'Page Nos réalisations',
    paths: [
      '/realisations',
      '/réalisations',
      '/nos-realisations',
      '/portfolio',
      '/references',
      '/références',
    ],
    labels: ['nos réalisations', 'réalisations', 'realisations', 'portfolio', 'références'],
  },
];

/** Fragments de classe qui trahissent un menu mobile, masqué en desktop. */
const MOBILE_MENU_CLASSES: readonly string[] = [
  'dmrespmenu',
  'dmburgermenu',
  'dmmobilenav',
  'dmmobile',
  'hamburger',
  'burger-menu',
  'offcanvas',
  'mobile-nav',
  'mobile-menu',
  'nav-mobile',
  'menu-mobile',
  'sidenav',
  'side-nav',
  'overlay-nav',
  'nav-drawer',
];

/** Profondeur d'ancêtres inspectée pour décider qu'une nav est masquée. */
const HIDDEN_ANCESTOR_DEPTH = 3;

interface NavLink {
  href: string;
  text: string;
}

interface NavInfo {
  index: number;
  links: NavLink[];
  hiddenReason: string | null;
}

export class NavStructureAnalyzer extends BaseAnalyzer {
  readonly id = 'NAV_STRUCTURE';
  readonly title = 'Structure de la navigation principale';

  analyze(page: HtmlPage, settings: EffectiveSettings): Promise<CheckResult> {
    if (!this.isEnabled(settings)) return Promise.resolve(this.na());

    const { $ } = page;
    const container = $('#hcontainer, .flex_hfcontainer');
    if (container.length === 0) {
      return Promise.resolve(
        this.na('Aucun #hcontainer détecté — critère non applicable sur cette page.'),
      );
    }

    const navs = container.find('nav[role="navigation"]');
    if (navs.length === 0) {
      return Promise.resolve(
        this.na('#hcontainer présent, mais aucun <nav role="navigation"> à l’intérieur.'),
      );
    }

    const all = this.describeNavs(page, navs);
    const visible = all.filter(nav => nav.hiddenReason === null);
    const hidden = all.filter(nav => nav.hiddenReason !== null);
    const items: CheckItem[] = [summaryItem(all, visible, hidden)];

    for (const nav of hidden) {
      items.push({
        key: `NAV_STRUCTURE.nav_hidden_${nav.index}`,
        label: `nav[${nav.index}] — menu mobile (masqué en desktop, non audité)`,
        status: 'info',
        detail: `Détection : ${nav.hiddenReason ?? ''}`,
      });
    }

    const primary = visible[0];
    if (!primary) {
      return Promise.resolve(
        this.fail(
          [
            ...items,
            {
              key: 'NAV_STRUCTURE.all_hidden',
              label: 'Aucune navigation visible dans #hcontainer',
              status: 'fail',
            },
          ],
          'Toutes les nav trouvées sont des menus mobiles masqués — la navigation desktop est introuvable.',
          ['Vérifier que la navigation desktop est présente et visible dans le DOM.'],
        ),
      );
    }

    if (visible.length > 1) this.describeSelection(visible, primary, items);

    if (primary.links.length === 0) {
      return Promise.resolve(
        this.fail(
          [
            ...items,
            {
              key: 'NAV_STRUCTURE.no_links',
              label: 'Aucun lien dans la navigation principale',
              status: 'fail',
            },
          ],
          'La navigation principale ne contient aucun lien exploitable.',
          ['Vérifier que les liens de navigation sont rendus dans le DOM.'],
        ),
      );
    }

    items.push({
      key: 'NAV_STRUCTURE.links_count',
      label: `${plural(primary.links.length, 'lien')} dans la navigation principale`,
      status: 'pass',
      detail: preview(primary.links, 8),
    });

    const missing = this.judgeExpectedPages(page, visible, primary, items);
    return Promise.resolve(this.conclude(items, missing, visible, hidden));
  }

  private describeNavs(page: HtmlPage, navs: Selection): NavInfo[] {
    const { $ } = page;
    const infos: NavInfo[] = [];

    navs.each((index, element) => {
      const node = $(element);
      const hiddenReason = hiddenReasonOf(page, node);
      const links: NavLink[] = [];

      // Les liens d'un menu masqué ne sont pas relevés : les compter ferait
      // croire à une navigation desktop que le visiteur ne voit pas.
      if (hiddenReason === null) {
        node.find('a').each((_, anchor) => {
          const href = $(anchor).attr('href')?.trim() ?? '';
          if (!href || href === '#') return;
          links.push({ href, text: $(anchor).text().trim() });
        });
      }

      infos.push({ index: index + 1, links, hiddenReason });
    });

    return infos;
  }

  private describeSelection(visible: NavInfo[], primary: NavInfo, items: CheckItem[]): void {
    for (const nav of visible) {
      items.push({
        key: `NAV_STRUCTURE.nav_detail_${nav.index}`,
        label: `nav[${nav.index}] — ${plural(nav.links.length, 'lien')}${
          nav.index === primary.index ? ' ★ navigation principale' : ''
        }`,
        status: 'info',
        detail: nav.links.length > 0 ? preview(nav.links) : 'Aucun lien exploitable',
      });
    }

    items.push({
      key: 'NAV_STRUCTURE.primary_selection',
      label: `Navigation principale retenue : nav[${primary.index}] (première visible dans le DOM)`,
      status: 'info',
      detail:
        'La position dans le DOM départage, pas le nombre de liens : la navigation principale y précède toujours les navigations secondaires.',
    });
  }

  /**
   * Les pages essentielles sont cherchées dans TOUTES les nav visibles.
   *
   * Une organisation courante place les pages métier dans la navigation
   * principale et les pages génériques dans une navigation secondaire : ne
   * regarder que la première pénaliserait un site correctement construit.
   */
  private judgeExpectedPages(
    page: HtmlPage,
    visible: NavInfo[],
    primary: NavInfo,
    items: CheckItem[],
  ): number {
    const links = visible.flatMap(nav => nav.links.map(link => ({ ...link, nav: nav.index })));
    let missing = 0;

    for (const expected of EXPECTED_PAGES) {
      const found = links.find(link => matches(link, expected, page.url));

      if (found) {
        items.push({
          key: `NAV_STRUCTURE.${expected.key}_present`,
          label: `${expected.label} présente (${
            found.nav === primary.index ? 'navigation principale' : `nav[${found.nav}]`
          })`,
          value: found.text || found.href,
          status: 'pass',
        });
        continue;
      }

      missing += 1;
      // Tous les manques portent le MÊME statut. La v1 marquait le premier en
      // avertissement et les suivants en échec, alors que le verdict global se
      // calcule, lui, sur le nombre de pages présentes : un critère pouvait
      // donc s'annoncer « avertissement » tout en contenant un item en échec.
      items.push({
        key: `NAV_STRUCTURE.${expected.key}_missing`,
        label: `${expected.label} absente de la navigation`,
        status: 'warning',
        detail: `Chemins attendus : ${expected.paths.join(', ')} — ou libellé « ${expected.labels[0] ?? ''} »`,
      });
    }

    return missing;
  }

  private conclude(
    items: CheckItem[],
    missing: number,
    visible: NavInfo[],
    hidden: NavInfo[],
  ): CheckResult {
    const present = EXPECTED_PAGES.length - missing;
    const { score, status } = navVerdict(missing, present);

    const context =
      visible.length > 1 || hidden.length > 0
        ? ` (${plural(visible.length, 'nav visible')}${
            hidden.length > 0 ? `, ${plural(hidden.length, 'menu mobile')} ignoré` : ''
          })`
        : '';

    return {
      checkId: this.id,
      checkTitle: this.title,
      globalScore: score,
      status,
      items,
      summary:
        missing === 0
          ? `Navigation complète — ${EXPECTED_PAGES.length}/${EXPECTED_PAGES.length} pages essentielles présentes.${context}`
          : `${present}/${EXPECTED_PAGES.length} pages essentielles — ${plural(missing, 'manquante')}.${context}`,
      recommendations: EXPECTED_PAGES.filter(expected =>
        items.some(item => item.key === `NAV_STRUCTURE.${expected.key}_missing`),
      ).map(
        expected =>
          `Ajouter la ${expected.label.toLowerCase()} dans la navigation (lien « ${expected.paths[0] ?? ''} » ou libellé « ${expected.labels[0] ?? ''} »).`,
      ),
    };
  }
}

function navVerdict(
  missing: number,
  present: number,
): { score: number; status: 'pass' | 'warning' | 'fail' } {
  if (missing === 0) return { score: 5, status: 'pass' };
  if (present >= 2) return { score: 3, status: 'warning' };
  if (present === 1) return { score: 2, status: 'warning' };
  return { score: 0, status: 'fail' };
}

function summaryItem(all: NavInfo[], visible: NavInfo[], hidden: NavInfo[]): CheckItem {
  const suffix =
    hidden.length > 0
      ? ` (${plural(visible.length, 'visible')}, ${plural(hidden.length, 'menu mobile')})`
      : '';
  return {
    key: 'NAV_STRUCTURE.nav_role_found',
    label: `${plural(all.length, '<nav role="navigation">')} trouvé dans #hcontainer${suffix}`,
    status: 'pass',
  };
}

/**
 * Pourquoi cette nav serait-elle invisible ?
 *
 * On inspecte la nav puis ses trois premiers ancêtres : Duda masque le menu
 * mobile sur un conteneur, pas sur la balise `nav` elle-même.
 */
function hiddenReasonOf(page: HtmlPage, node: Selection): string | null {
  const own = elementHiddenReason(node);
  if (own) return own;

  let parent = node.parent();
  for (let depth = 0; depth < HIDDEN_ANCESTOR_DEPTH && parent.length > 0; depth += 1) {
    const reason = elementHiddenReason(parent);
    if (reason) {
      const tag = String(parent.prop('tagName') ?? 'element').toLowerCase();
      return `conteneur <${tag}> : ${reason}`;
    }
    parent = parent.parent();
  }

  return null;
}

function elementHiddenReason(node: Selection): string | null {
  if (node.attr('aria-hidden') === 'true') return 'aria-hidden="true"';

  const style = (node.attr('style') ?? '').toLowerCase().replace(/\s/g, '');
  if (style.includes('display:none')) return 'display:none (style en ligne)';
  if (style.includes('visibility:hidden')) return 'visibility:hidden (style en ligne)';

  const classes = (node.attr('class') ?? '').toLowerCase();
  return MOBILE_MENU_CLASSES.find(pattern => classes.includes(pattern))
    ? `classe « ${MOBILE_MENU_CLASSES.find(pattern => classes.includes(pattern)) ?? ''} »`
    : null;
}

function matches(link: NavLink, expected: ExpectedPage, pageUrl: string): boolean {
  const text = normalize(link.text);
  if (expected.labels.some(label => text === label || text.includes(label))) return true;

  const path = pathOf(link.href, pageUrl);
  return path !== null && expected.paths.some(token => pathMatches(path, token));
}

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ').normalize('NFC');
}

function pathOf(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

function pathMatches(pathname: string, token: string): boolean {
  // La racine d'un site en aperçu Duda est un chemin `/site/{hash}`, pas `/`.
  if (token === '/') return pathname === '/' || /^\/site\/[a-f0-9-]+\/?$/.test(pathname);

  const normalized = token.replace(/\/$/, '');
  return (
    pathname === normalized || pathname.endsWith(normalized) || pathname.includes(`${normalized}/`)
  );
}

function preview(links: readonly NavLink[], max = 6): string {
  const shown = links
    .slice(0, max)
    .map(link => (link.text || link.href).slice(0, 20))
    .join(' · ');
  return links.length > max ? `${shown} · …+${links.length - max}` : shown;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}
