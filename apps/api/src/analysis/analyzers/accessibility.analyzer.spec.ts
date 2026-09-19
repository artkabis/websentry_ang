import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { AccessibilityAnalyzer } from './accessibility.analyzer.js';

const analyzer = new AccessibilityAnalyzer();
const settings = makeSettings();

/** Page irréprochable : tous les repères, un nom sur chaque élément. */
const SOUND = `<html lang="fr"><body>
  <a href="#contenu">Aller au contenu</a>
  <header>En-tête</header>
  <nav>Menu</nav>
  <main id="contenu"><img src="/a.png" alt="Une image"><a href="/x">Un lien</a></main>
  <footer>Pied</footer>
</body></html>`;

function page(body: string, lang = ' lang="fr"') {
  return makePage(`<html${lang}><body>${body}</body></html>`);
}

describe('AccessibilityAnalyzer', () => {
  it('ne signale rien sur une page saine', async () => {
    const result = await analyzer.analyze(makePage(SOUND), settings);

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  describe('lien d’évitement', () => {
    it('AVERTIT quand il manque', async () => {
      const result = await analyzer.analyze(page('<main>x</main>'), settings);

      expect(result.items.some(item => item.key === 'A11Y.skip_missing')).toBe(true);
    });

    it('le reconnaît à son libellé', async () => {
      const result = await analyzer.analyze(
        page('<a href="#main">Aller au contenu principal</a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.skip_ok')).toBe(true);
    });
  });

  describe('repères sémantiques', () => {
    it('nomme les repères absents', async () => {
      const result = await analyzer.analyze(page('<div>Tout en div</div>'), settings);

      const item = result.items.find(entry => entry.key === 'A11Y.structure_incomplete');
      expect(item?.detail).toContain('<main>');
      expect(item?.detail).toContain('<footer>');
    });

    it('accepte les rôles ARIA équivalents', async () => {
      const result = await analyzer.analyze(
        page(
          '<a href="#c">Aller au contenu</a><div role="banner">h</div><div role="navigation">n</div><div role="main">m</div><div role="contentinfo">f</div>',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.structure_ok')).toBe(true);
    });
  });

  describe('images', () => {
    it('ÉCHOUE sur une image sans attribut alt', async () => {
      const result = await analyzer.analyze(page('<img src="/a.png">'), settings);

      expect(result.items.some(item => item.key === 'A11Y.img_alt_missing')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('accepte un alt VIDE, qui déclare une image décorative', async () => {
      // `alt=""` est une décision de l'auteur, pas un oubli : la technologie
      // d'assistance saute l'image au lieu d'en lire l'URL.
      const result = await analyzer.analyze(page('<img src="/deco.png" alt="">'), settings);

      expect(result.items.some(item => item.key === 'A11Y.img_alt_ok')).toBe(true);
    });
  });

  describe('liens', () => {
    it('ÉCHOUE sur un lien sans nom accessible', async () => {
      const result = await analyzer.analyze(page('<a href="/vide"></a>'), settings);

      const item = result.items.find(entry => entry.key === 'A11Y.links_empty');
      expect(item?.status).toBe('fail');
      expect(item?.detail).toContain('/vide');
    });

    it('accepte un lien nommé par l’alt de son image', async () => {
      const result = await analyzer.analyze(
        page('<a href="/x"><img src="/i.png" alt="Nos offres"></a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.links_ok')).toBe(true);
    });

    it('REFUSE un lien dont l’image est décorative', async () => {
      // `alt=""` retire l'image de l'arbre accessible : le lien n'a alors plus
      // aucun nom, et c'est bien un défaut.
      const result = await analyzer.analyze(
        page('<a href="/x"><img src="/i.png" alt=""></a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.links_empty')).toBe(true);
    });

    it('accepte un aria-label', async () => {
      const result = await analyzer.analyze(
        page('<a href="/x" aria-label="Ouvrir le panier"></a>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.links_ok')).toBe(true);
    });
  });

  describe('formulaires', () => {
    it('accepte un champ lié par for/id', async () => {
      const result = await analyzer.analyze(
        page('<label for="n">Nom</label><input id="n">'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.form_labeled')).toBe(true);
    });

    it('accepte un champ ENVELOPPÉ dans son label', async () => {
      // HTML parfaitement valide et très répandu, que la v1 comptait en défaut
      // parce qu'elle n'acceptait que la liaison par `for`.
      const result = await analyzer.analyze(page('<label>Nom <input></label>'), settings);

      expect(result.items.some(item => item.key === 'A11Y.form_labeled')).toBe(true);
    });

    it('ÉCHOUE sur un champ sans étiquette', async () => {
      const result = await analyzer.analyze(
        page('<input type="text" placeholder="Nom">'),
        settings,
      );

      expect(result.items.some(item => item.key === 'A11Y.form_no_label')).toBe(true);
    });

    it('ne se laisse pas casser par un identifiant HOSTILE', async () => {
      // L'identifiant vient de la page analysée. La v1 le concaténait dans un
      // sélecteur `label[for="…"]` : un guillemet y cassait le sélecteur, donc
      // le critère entier, sur une valeur que l'auteur de la page contrôle.
      const hostile = '<label for="a">A</label><input id=\'x"], *\'>';
      const result = await analyzer.analyze(page(hostile), settings);

      expect(result.items.some(item => item.key === 'A11Y.form_no_label')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('ne dit rien quand la page n’a aucun champ', async () => {
      const result = await analyzer.analyze(page('<p>Texte</p>'), settings);

      expect(result.items.some(item => item.key?.startsWith('A11Y.form'))).toBe(false);
    });
  });

  it('AVERTIT sur un tabindex positif', async () => {
    const result = await analyzer.analyze(page('<div tabindex="3">x</div>'), settings);

    expect(result.items.some(item => item.key === 'A11Y.tabindex_positive')).toBe(true);
  });

  it('ne reproche rien à tabindex="0" ni "-1"', async () => {
    const result = await analyzer.analyze(
      page('<div tabindex="0">a</div><div tabindex="-1">b</div>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'A11Y.tabindex_positive')).toBe(false);
  });

  describe('rôles ARIA', () => {
    it('AVERTIT sur un rôle inexistant', async () => {
      const result = await analyzer.analyze(page('<div role="bouton">x</div>'), settings);

      expect(result.items.some(item => item.key === 'A11Y.aria_invalid')).toBe(true);
    });

    it('accepte une liste de rôles dont le premier est reconnu', async () => {
      const result = await analyzer.analyze(page('<div role="button widget">x</div>'), settings);

      expect(result.items.some(item => item.key === 'A11Y.aria_invalid')).toBe(false);
    });
  });

  it('ÉCHOUE quand <html> n’a pas d’attribut lang', async () => {
    const result = await analyzer.analyze(page('<p>x</p>', ''), settings);

    expect(result.items.some(item => item.key === 'A11Y.lang_missing')).toBe(true);
  });

  it('ANNULE la note à partir de trois défauts bloquants', async () => {
    const result = await analyzer.analyze(
      page('<img src="/a.png"><a href="/x"></a><input type="text">', ''),
      settings,
    );

    expect(result.globalScore).toBe(0);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage(SOUND),
      makeSettings({ disabledChecks: ['ACCESSIBILITY'] }),
    );

    expect(result.status).toBe('na');
  });
});
