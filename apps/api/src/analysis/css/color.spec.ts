import { describe, expect, it } from 'vitest';
import { blendOver, contrastRatio, isTransparent, parseColor, relativeLuminance } from './color.js';

/** Raccourci de lecture : une couleur opaque en RVB. */
function rgb(r: number, g: number, b: number) {
  return { r, g, b, a: 1 };
}

describe('lecture d’une couleur CSS', () => {
  it('rend null pour une entrée vide ou absente', () => {
    expect(parseColor(null)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor('   ')).toBeNull();
  });

  it('rend null pour une valeur qui n’est pas une couleur', () => {
    expect(parseColor('pas-une-couleur')).toBeNull();
    expect(parseColor('#xyz')).toBeNull();
  });

  describe('notations hexadécimales', () => {
    it('lit une forme à six chiffres', () => {
      expect(parseColor('#336699')).toEqual(rgb(0x33, 0x66, 0x99));
    });

    it('DÉVELOPPE une forme à trois chiffres', () => {
      expect(parseColor('#369')).toEqual(rgb(0x33, 0x66, 0x99));
    });

    it('lit la transparence d’une forme à huit chiffres', () => {
      expect(parseColor('#33669980')?.a).toBeCloseTo(0.502, 2);
    });

    it('développe une forme à quatre chiffres', () => {
      expect(parseColor('#3698')?.a).toBeCloseTo(0.533, 2);
    });
  });

  describe('couleurs nommées', () => {
    it('reconnaît un nom du vocabulaire CSS', () => {
      expect(parseColor('white')).toEqual(rgb(255, 255, 255));
      expect(parseColor('rebeccapurple')).toEqual(rgb(102, 51, 153));
    });

    it('traite « transparent » comme un noir d’opacité nulle', () => {
      expect(parseColor('transparent')?.a).toBe(0);
    });

    it('ignore la casse', () => {
      expect(parseColor('WHITE')).toEqual(parseColor('white'));
    });
  });

  describe('fonctions de couleur', () => {
    it('lit rgb() et rgba()', () => {
      expect(parseColor('rgb(51, 102, 153)')).toEqual(rgb(51, 102, 153));
      expect(parseColor('rgba(51, 102, 153, 0.5)')?.a).toBe(0.5);
    });

    it('accepte la syntaxe moderne sans virgule', () => {
      expect(parseColor('rgb(51 102 153 / 50%)')?.a).toBe(0.5);
    });

    it('accepte des composantes en pourcentage', () => {
      expect(parseColor('rgb(100%, 0%, 0%)')).toEqual(rgb(255, 0, 0));
    });

    it('lit hsl()', () => {
      expect(parseColor('hsl(0, 100%, 50%)')).toEqual(rgb(255, 0, 0));
      expect(parseColor('hsl(120 100% 50%)')).toEqual(rgb(0, 255, 0));
    });

    it('lit hwb()', () => {
      expect(parseColor('hwb(0 0% 0%)')).toEqual(rgb(255, 0, 0));
    });

    it('lit les espaces perceptuels', () => {
      // `oklch` et consorts sont de plus en plus employés dans les thèmes
      // modernes : les ignorer priverait de mesure les pages récentes.
      expect(parseColor('oklch(0.7 0.15 30)')).not.toBeNull();
      expect(parseColor('lab(50% 40 30)')).not.toBeNull();
    });

    it('lit color() dans un espace nommé', () => {
      expect(parseColor('color(srgb 1 0 0)')).toEqual(rgb(255, 0, 0));
    });

    it('lit un mélange de deux couleurs', () => {
      const mixed = parseColor('color-mix(in srgb, #000 50%, #fff)');

      expect(mixed).not.toBeNull();
      expect(mixed?.r).toBeGreaterThan(0);
      expect(mixed?.r).toBeLessThan(255);
    });

    it('rend null pour un mélange incomplet', () => {
      expect(parseColor('color-mix(in srgb, #000)')).toBeNull();
    });

    describe('espaces colorimétriques de color()', () => {
      // Un rouge saturé doit rester un rouge dans chaque espace : le test
      // vérifie surtout que chaque nom est câblé sur la BONNE matrice de
      // conversion — une permutation y passerait inaperçue autrement.
      it.each([
        ['srgb', 'color(srgb 1 0 0)'],
        ['srgb-linear', 'color(srgb-linear 1 0 0)'],
        ['display-p3', 'color(display-p3 1 0 0)'],
        ['rec2020', 'color(rec2020 1 0 0)'],
        ['a98-rgb', 'color(a98-rgb 1 0 0)'],
        ['prophoto-rgb', 'color(prophoto-rgb 1 0 0)'],
      ])('convertit un rouge depuis %s', (_space, value) => {
        const parsed = parseColor(value);

        expect(parsed).not.toBeNull();
        expect(parsed?.r).toBeGreaterThan(parsed?.g ?? 0);
        expect(parsed?.r).toBeGreaterThan(parsed?.b ?? 0);
      });

      it.each([
        ['xyz', 'color(xyz 0.2 0.2 0.2)'],
        ['xyz-d65', 'color(xyz-d65 0.2 0.2 0.2)'],
        ['xyz-d50', 'color(xyz-d50 0.2 0.2 0.2)'],
      ])('convertit un gris depuis %s', (_space, value) => {
        const parsed = parseColor(value);

        expect(parsed).not.toBeNull();
        expect(parsed?.r).toBeGreaterThan(0);
      });

      it('rend null pour un espace inconnu', () => {
        expect(parseColor('color(espace-imaginaire 1 0 0)')).toBeNull();
      });

      it('lit la transparence d’un color()', () => {
        expect(parseColor('color(srgb 1 0 0 / 0.25)')?.a).toBe(0.25);
      });
    });

    describe('espaces perceptuels', () => {
      it('place un lch très clair près du blanc', () => {
        const light = parseColor('lch(95% 5 100)');

        expect(light?.r).toBeGreaterThan(200);
      });

      it('place un oklab très sombre près du noir', () => {
        const dark = parseColor('oklab(0.1 0 0)');

        expect(dark?.r).toBeLessThan(80);
      });

      it('accepte une teinte exprimée en tours ou en radians', () => {
        expect(parseColor('hsl(0.5turn 100% 50%)')).not.toBeNull();
        expect(parseColor('hsl(3.14rad 100% 50%)')).not.toBeNull();
      });

      it('traite le mot-clé none comme zéro', () => {
        expect(parseColor('rgb(none 0 0)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      });
    });

    describe('mélanges', () => {
      it('respecte les proportions demandées', () => {
        const mostlyWhite = parseColor('color-mix(in srgb, #000 10%, #fff 90%)');
        const mostlyBlack = parseColor('color-mix(in srgb, #000 90%, #fff 10%)');

        expect(mostlyWhite?.r).toBeGreaterThan(mostlyBlack?.r ?? 255);
      });

      it('mélange aussi dans un espace perceptuel', () => {
        expect(parseColor('color-mix(in oklab, red, blue)')).not.toBeNull();
      });

      it('retombe sur un espace perceptuel quand celui demandé est inconnu', () => {
        expect(parseColor('color-mix(in espace-imaginaire, red, blue)')).not.toBeNull();
      });

      it('rend null quand une des deux couleurs est illisible', () => {
        expect(parseColor('color-mix(in srgb, pas-une-couleur, #fff)')).toBeNull();
      });
    });

    it('BORNE les composantes hors intervalle', () => {
      expect(parseColor('rgb(300, -20, 128)')).toEqual(rgb(255, 0, 128));
    });
  });
});

describe('transparence', () => {
  it('reconnaît une couleur entièrement transparente', () => {
    expect(isTransparent({ r: 0, g: 0, b: 0, a: 0 })).toBe(true);
    expect(isTransparent(null)).toBe(true);
  });

  it('ne tient pas une couleur partiellement transparente pour absente', () => {
    expect(isTransparent({ r: 0, g: 0, b: 0, a: 0.5 })).toBe(false);
  });
});

describe('composition alpha', () => {
  it('rend la couleur du dessus quand elle est opaque', () => {
    expect(blendOver(rgb(255, 0, 0), rgb(0, 0, 255))).toEqual(rgb(255, 0, 0));
  });

  it('rend le fond quand le dessus est transparent', () => {
    const result = blendOver({ r: 255, g: 0, b: 0, a: 0 }, rgb(0, 0, 255));

    expect(result.b).toBe(255);
  });

  it('MÉLANGE une couche à moitié transparente', () => {
    // C'est ce calcul qui décide du contraste réel d'un texte posé sur une
    // surimpression : l'ignorer donnerait la couleur du fond, pas celle vue.
    const result = blendOver({ r: 0, g: 0, b: 0, a: 0.5 }, rgb(255, 255, 255));

    expect(result.r).toBeCloseTo(127.5, 0);
  });
});

describe('luminance et contraste', () => {
  it('place le noir et le blanc aux extrêmes', () => {
    expect(relativeLuminance(rgb(0, 0, 0))).toBe(0);
    expect(relativeLuminance(rgb(255, 255, 255))).toBe(1);
  });

  it('donne le ratio maximal entre noir et blanc', () => {
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 1);
  });

  it('donne 1 pour deux couleurs identiques', () => {
    expect(contrastRatio(rgb(128, 128, 128), rgb(128, 128, 128))).toBeCloseTo(1, 5);
  });

  it('est SYMÉTRIQUE : l’ordre des couleurs ne change pas le ratio', () => {
    const forward = contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255));
    const backward = contrastRatio(rgb(255, 255, 255), rgb(0, 0, 0));

    expect(forward).toBeCloseTo(backward, 5);
  });

  it('situe le seuil WCAG AA au bon endroit', () => {
    // #767676 sur blanc est la limite admise pour un texte courant : c'est la
    // valeur de référence de la recommandation.
    expect(contrastRatio(rgb(0x76, 0x76, 0x76), rgb(255, 255, 255))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(0x77, 0x77, 0x77), rgb(255, 255, 255))).toBeLessThan(4.5);
  });
});
