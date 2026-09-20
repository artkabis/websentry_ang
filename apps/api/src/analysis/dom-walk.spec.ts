import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  classIncludesAny,
  classTokensOf,
  elementOf,
  firstElementOf,
  firstImageIn,
  hasAncestorMatching,
  selfAndAncestors,
} from './dom-walk.js';

function load(html: string) {
  const $ = cheerio.load(html);
  return { $, cible: $('a') };
}

describe('parcours du document', () => {
  it('reconnaît un élément, et rien d’autre', () => {
    const { $ } = load('<div><a href="/x">Lien</a></div>');

    expect(elementOf($('a').get(0))?.name).toBe('a');
    expect(elementOf(null)).toBeNull();
    expect(elementOf('texte')).toBeNull();
    expect(elementOf({ sans: 'attribs' })).toBeNull();
  });

  it('rend null pour une sélection vide', () => {
    expect(firstElementOf(load('<div></div>').$('a'))).toBeNull();
  });

  it('remonte les ancêtres du PLUS PROCHE au plus lointain', () => {
    // L'ordre décide du classement : le conteneur le plus proche l'emporte.
    const { cible } = load('<body><main><section><a href="/x">Lien</a></section></main></body>');
    const element = firstElementOf(cible);

    expect([...ancestorsOf(element!)].map(node => node.name)).toEqual([
      'section',
      'main',
      'body',
      'html',
    ]);
  });

  it('s’arrête au document, qui n’est pas un élément', () => {
    const { cible } = load('<a href="/x">Lien</a>');

    expect([...ancestorsOf(firstElementOf(cible)!)].every(node => node.name !== 'root')).toBe(true);
  });

  it('inclut l’élément lui-même quand on le demande', () => {
    const { cible } = load('<main><a href="/x">Lien</a></main>');

    expect([...selfAndAncestors(firstElementOf(cible)!)][0]?.name).toBe('a');
  });

  describe('recherche d’un signal chez les ancêtres', () => {
    it('trouve un ancêtre porteur', () => {
      const { cible } = load('<footer><span><a href="/x">Lien</a></span></footer>');

      expect(
        hasAncestorMatching(cible, new WeakMap(), node => node.name === 'footer', {
          includeSelf: false,
        }),
      ).toBe(true);
    });

    it('ignore l’élément lui-même quand on ne l’inclut pas', () => {
      const { cible } = load('<div><a class="btn" href="/x">Lien</a></div>');
      const porteLaClasse = (node: { attribs: Record<string, string> }) =>
        (node.attribs['class'] ?? '').includes('btn');

      expect(hasAncestorMatching(cible, new WeakMap(), porteLaClasse, { includeSelf: false })).toBe(
        false,
      );
      expect(hasAncestorMatching(cible, new WeakMap(), porteLaClasse, { includeSelf: true })).toBe(
        true,
      );
    });

    it('MÉMORISE le résultat plutôt que de remonter deux fois', () => {
      // C'est la raison d'être de ce module : sur une page de deux cents liens,
      // la même chaîne d'ascendance serait remontée deux cents fois.
      const { cible } = load('<footer><a href="/x">Lien</a></footer>');
      const cache = new WeakMap<object, boolean>();
      let appels = 0;
      const compte = (node: { name: string }) => {
        appels += 1;
        return node.name === 'footer';
      };

      hasAncestorMatching(cible, cache, compte, { includeSelf: false });
      const avant = appels;
      hasAncestorMatching(cible, cache, compte, { includeSelf: false });

      expect(appels).toBe(avant);
    });

    it('rend faux sur une sélection vide', () => {
      expect(
        hasAncestorMatching(load('<div></div>').$('a'), new WeakMap(), () => true, {
          includeSelf: true,
        }),
      ).toBe(false);
    });
  });

  describe('lecture des classes', () => {
    it('rend les jetons, pas la chaîne', () => {
      const { cible } = load('<a class="btn  primaire" href="/x">Lien</a>');

      expect(classTokensOf(firstElementOf(cible)!)).toEqual(['btn', 'primaire']);
    });

    it('reconnaît une SOUS-CHAÎNE de classe', () => {
      // `[class*="nav"]` visait une sous-chaîne : `dmRespNav` y répondait.
      const { cible } = load('<a class="p_dmRespNav" href="/x">Lien</a>');

      expect(classIncludesAny(firstElementOf(cible)!, ['dmRespNav'])).toBe(true);
      expect(classIncludesAny(firstElementOf(cible)!, ['absent'])).toBe(false);
    });
  });

  describe('première image sous un élément', () => {
    it('trouve une image directe', () => {
      const { cible } = load('<a href="/x"><img src="/a.png" alt="Logo"></a>');

      expect(firstImageIn(firstElementOf(cible))?.attribs['alt']).toBe('Logo');
    });

    it('la trouve EN PROFONDEUR', () => {
      const { cible } = load(
        '<a href="/x"><span><em><img src="/a.png" alt="Profond"></em></span></a>',
      );

      expect(firstImageIn(firstElementOf(cible))?.attribs['alt']).toBe('Profond');
    });

    it('rend la PREMIÈRE dans l’ordre du document', () => {
      const { cible } = load(
        '<a href="/x"><span><img src="/1.png" alt="Une"></span><img src="/2.png" alt="Deux"></a>',
      );

      expect(firstImageIn(firstElementOf(cible))?.attribs['alt']).toBe('Une');
    });

    it('rend null sans image', () => {
      const { cible } = load('<a href="/x"><span>Texte</span></a>');

      expect(firstImageIn(firstElementOf(cible))).toBeNull();
      expect(firstImageIn(null)).toBeNull();
    });
  });
});
