import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { PictogramAnalyzer } from './pictogram.analyzer.js';

const analyzer = new PictogramAnalyzer();
const settings = makeSettings();

/** Feuille de style qui charge réellement la bibliothèque d'icônes. */
const FA_STYLESHEET = '<link rel="stylesheet" href="https://cdn.exemple.fr/font-awesome.min.css">';

describe('PictogramAnalyzer', () => {
  it('ne signale rien sur une page sans icône', async () => {
    const result = await analyzer.analyze(makePage('<p>Texte</p>'), settings);

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'PICTO.no_icons')).toBe(true);
  });

  it('compte les icônes Font Awesome', async () => {
    const result = await analyzer.analyze(
      makePage(
        `${FA_STYLESHEET}<p><i class="fas fa-phone" aria-hidden="true"></i> Appelez-nous</p>`,
      ),
      settings,
    );

    expect(result.items.find(item => item.key === 'PICTO.fa_count')?.label).toContain('1');
  });

  it('NE CONFOND PAS une classe contenant « fa- » avec une icône', async () => {
    // `[class*="fa-"]` capte la sous-chaîne : une classe `sofa-image` passait
    // en v1 pour une icône, et gonflait le décompte d'une page qui n'en a pas.
    const result = await analyzer.analyze(
      makePage('<div class="sofa-image"></div><div class="banner-bi-color"></div>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.no_icons')).toBe(true);
  });

  it('DÉTECTE une icône sans alternative ni texte voisin', async () => {
    // La v1 comparait au texte du PARENT, qui contient l'icône elle-même et
    // n'est presque jamais vide : le contrôle ne se déclenchait jamais.
    const result = await analyzer.analyze(
      makePage(`${FA_STYLESHEET}<div><i class="fas fa-phone"></i></div>`),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.fa_accessibility')).toBe(true);
    expect(result.status).toBe('warning');
  });

  it('accepte une icône accompagnée de texte', async () => {
    const result = await analyzer.analyze(
      makePage(`${FA_STYLESHEET}<div><i class="fas fa-phone"></i> Nous appeler</div>`),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.fa_accessibility')).toBe(false);
  });

  it('accepte une icône décorative marquée aria-hidden', async () => {
    const result = await analyzer.analyze(
      makePage(`${FA_STYLESHEET}<div><i class="fas fa-phone" aria-hidden="true"></i></div>`),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.fa_accessibility')).toBe(false);
  });

  it('AVERTIT quand la bibliothèque n’est pas chargée', async () => {
    const result = await analyzer.analyze(
      makePage('<i class="fas fa-phone" aria-hidden="true"></i>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.fa_not_loaded')).toBe(true);
  });

  it('ne tient PAS une simple mention textuelle pour un chargement', async () => {
    const result = await analyzer.analyze(
      makePage('<p>Nous utilisons Font Awesome</p><i class="fa-phone" aria-hidden="true"></i>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.fa_not_loaded')).toBe(true);
  });

  it('compte les Material et Bootstrap Icons', async () => {
    const result = await analyzer.analyze(
      makePage('<span class="material-icons">home</span><i class="bi bi-house"></i>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'PICTO.mi_count')).toBe(true);
    expect(result.items.some(item => item.key === 'PICTO.bi_count')).toBe(true);
  });

  describe('SVG en ligne', () => {
    it('AVERTIT sur un SVG sans titre ni aria-hidden', async () => {
      const result = await analyzer.analyze(makePage('<svg><path/></svg>'), settings);

      expect(result.items.some(item => item.key === 'PICTO.svg_accessibility')).toBe(true);
    });

    it('accepte un SVG titré', async () => {
      const result = await analyzer.analyze(
        makePage('<svg><title>Téléphone</title><path/></svg>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'PICTO.svg_accessibility')).toBe(false);
    });

    it('accepte un SVG explicitement décoratif', async () => {
      const result = await analyzer.analyze(
        makePage('<svg role="presentation"><path/></svg>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'PICTO.svg_accessibility')).toBe(false);
    });
  });

  it('additionne toutes les familles dans le total', async () => {
    const result = await analyzer.analyze(
      makePage(
        `${FA_STYLESHEET}<i class="fas fa-phone" aria-hidden="true"></i><span class="material-icons">home</span><svg aria-hidden="true"></svg>`,
      ),
      settings,
    );

    expect(result.items.find(item => item.key === 'PICTO.total')?.label).toContain('3');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<svg></svg>'),
      makeSettings({ disabledChecks: ['PICTOGRAM'] }),
    );

    expect(result.status).toBe('na');
  });
});
