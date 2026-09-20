/**
 * Navigation déclarée par l'éditeur — fonction PURE.
 *
 * L'éditeur publie sa navigation dans un `NavItems` encodé en base64, qui dit
 * quelles pages sont RÉELLEMENT au menu, indépendamment du rendu. C'est une
 * source plus fiable que le DOM : un menu rendu en JavaScript, ou masqué par un
 * gabarit, y figure quand même.
 *
 * Seules les URL et leur appartenance au menu sont extraites. La v1 en tire
 * aussi les silos de navigation ; ils servent à la cartographie inter-pages,
 * qui n'est pas du ressort de ce module.
 */

interface NavItem {
  title?: unknown;
  path?: unknown;
  inNavigation?: unknown;
  subNav?: unknown;
}

export interface NavPage {
  title: string;
  url: string;
  /** Vrai seulement si la page ET toute sa chaîne d'ancêtres sont au menu. */
  inNavigation: boolean;
}

/** Chemin que l'éditeur donne à un item de menu sans page propre. */
const DEAD_PATH = '#';

export function extractDudaNavPages(html: string, pageUrl: string): NavPage[] {
  const encoded = /NavItems\s*:\s*['"]([A-Za-z0-9+/=]+)['"]/.exec(html)?.[1];
  if (!encoded) return [];

  let items: unknown;
  try {
    items = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const origin = resolveOrigin(html, pageUrl);
  if (!origin) return [];

  const pages: NavPage[] = [];
  const seen = new Set<string>();
  collect(items as NavItem[], true, origin, pages, seen);
  return pages;
}

/**
 * L'origine vient de `NavbarLiveHomePage` quand elle est déclarée.
 *
 * Sur un site consulté en aperçu, les chemins du menu sont relatifs au domaine
 * de PRODUCTION : les résoudre contre l'URL d'aperçu fabriquerait des URL qui
 * n'existent nulle part.
 */
function resolveOrigin(html: string, pageUrl: string): string | null {
  const declared = /NavbarLiveHomePage\s*:\s*['"]([^'"]+)['"]/.exec(html)?.[1];
  try {
    return new URL(declared ?? pageUrl).origin;
  } catch {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return null;
    }
  }
}

function collect(
  items: readonly NavItem[],
  ancestorInNav: boolean,
  origin: string,
  pages: NavPage[],
  seen: Set<string>,
): void {
  for (const item of items) {
    // Une page n'est au menu que si TOUS ses ancêtres y sont : un sous-item
    // d'un parent retiré du menu n'est atteignable par personne.
    const inNavigation = ancestorInNav && item.inNavigation === true;
    const path = typeof item.path === 'string' ? item.path : '';

    if (path && path !== DEAD_PATH) {
      try {
        const url = new URL(path, origin).href;
        if (!seen.has(url)) {
          seen.add(url);
          pages.push({
            title: typeof item.title === 'string' ? item.title : '',
            url,
            inNavigation,
          });
        }
      } catch {
        /* chemin illisible — l'item est ignoré, pas l'arbre entier */
      }
    }

    if (Array.isArray(item.subNav)) {
      collect(item.subNav as NavItem[], inNavigation, origin, pages, seen);
    }
  }
}
