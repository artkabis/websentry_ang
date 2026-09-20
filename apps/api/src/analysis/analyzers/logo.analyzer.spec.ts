import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { LogoAnalyzer } from './logo.analyzer.js';

const analyzer = new LogoAnalyzer();
const settings = makeSettings();

/** En-tête nominal : logo lié à l'accueil, avec alt et title. */
const PERFECT =
  '<header><a href="/"><img src="/logo.png" alt="Boulangerie Durand" title="Accueil"></a></header>';

function page(body: string, url = 'https://exemple.fr/contact') {
  return makePage(`<html><body>${body}</body></html>`, { url });
}

describe('LogoAnalyzer', () => {
  it('valide un logo complet', async () => {
    const result = await analyzer.analyze(page(PERFECT), settings);

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('ÉCHOUE quand aucun logo n’est trouvé', async () => {
    const result = await analyzer.analyze(page('<header><nav>Menu</nav></header>'), settings);

    expect(result.status).toBe('fail');
    expect(result.items[0]?.key).toBe('LOGO.not_found');
  });

  it('NE CONFOND PAS le logo avec un drapeau de langue', async () => {
    // Les deux vivent dans le même en-tête : prendre le drapeau annoncerait un
    // alt et un lien qui ne sont pas ceux du logo.
    const result = await analyzer.analyze(
      page(
        '<header><div class="language-selector"><img src="/fr.svg" alt="Français"></div><div class="logo"><a href="/"><img src="/logo.png" alt="Durand" title="Accueil"></a></div></header>',
      ),
      settings,
    );

    expect(result.items.find(item => item.key === 'LOGO.alt_ok')?.label).toContain('Durand');
  });

  describe('texte alternatif', () => {
    it('ÉCHOUE sur un alt absent', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img src="/logo.png"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.alt_missing')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('ÉCHOUE sur un alt vide — le logo n’est pas décoratif', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img src="/logo.png" alt=""></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.alt_empty')).toBe(true);
    });

    it('traite un alt d’espaces comme un alt vide', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img src="/logo.png" alt="   "></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.alt_empty')).toBe(true);
    });
  });

  describe('lien', () => {
    it('AVERTIT sur un logo non cliquable', async () => {
      const result = await analyzer.analyze(
        page('<header><img src="/logo.png" alt="Durand"></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.not_clickable')).toBe(true);
    });

    it('AVERTIT quand le logo mène ailleurs que l’accueil', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/blog"><img src="/l.png" alt="D" title="Accueil"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_other_page')).toBe(true);
    });

    it('AVERTIT sur un lien vers un domaine externe', async () => {
      const result = await analyzer.analyze(
        page(
          '<header><a href="https://ailleurs.fr/"><img src="/l.png" alt="D" title="Accueil"></a></header>',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_external')).toBe(true);
    });

    it('AVERTIT sur un lien sans href', async () => {
      const result = await analyzer.analyze(
        page('<header><a><img src="/l.png" alt="D" title="Accueil"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_no_href')).toBe(true);
    });

    it('accepte la racine d’un site consulté depuis l’éditeur', async () => {
      // En aperçu, Duda remplace le href du logo par le chemin courant :
      // l'ignorer signalerait « logo mal lié » sur tout site vu dans l'éditeur.
      const result = await analyzer.analyze(
        page(
          '<header><a href="/site/abc123/page?insitepreview=true"><img src="/l.png" alt="D" title="Accueil"></a></header>',
          'https://exemple.fr/site/abc123/page?insitepreview=true',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_homepage')).toBe(true);
    });

    it('accepte le chemin racine d’un site Duda publié', async () => {
      const result = await analyzer.analyze(
        page(
          '<header><a href="/site/abc123/"><img src="/l.png" alt="D" title="Accueil"></a></header>',
          'https://exemple.fr/site/abc123/contact',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_homepage')).toBe(true);
    });
  });

  describe('infobulle', () => {
    it('AVERTIT quand le title ne mentionne pas l’accueil', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img src="/l.png" alt="D" title="Logo"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_title_missing')).toBe(true);
    });

    it('accepte le title quelle que soit sa casse', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img src="/l.png" alt="D" title="ACCUEIL"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.link_title_ok')).toBe(true);
    });
  });

  describe('source de l’image', () => {
    it('n’affiche que le nom de fichier', async () => {
      const result = await analyzer.analyze(
        page(
          '<header><a href="/"><img src="https://cdn.exemple.fr/a/b/logo.png?v=12&w=300" alt="D" title="Accueil"></a></header>',
        ),
        settings,
      );

      expect(result.items.find(item => item.key === 'LOGO.src_ok')?.label).toContain('logo.png');
    });

    it('accepte une image différée', async () => {
      // Une image en chargement différé a bien une source, simplement pas
      // encore dans `src`.
      const result = await analyzer.analyze(
        page('<header><a href="/"><img data-src="/logo.png" alt="D" title="Accueil"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.src_ok')).toBe(true);
    });

    it('ÉCHOUE quand l’image n’a aucune source', async () => {
      const result = await analyzer.analyze(
        page('<header><a href="/"><img alt="D" title="Accueil"></a></header>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'LOGO.src_missing')).toBe(true);
      expect(result.status).toBe('fail');
    });
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      page(PERFECT),
      makeSettings({ disabledChecks: ['LOGO'] }),
    );

    expect(result.status).toBe('na');
  });
});
