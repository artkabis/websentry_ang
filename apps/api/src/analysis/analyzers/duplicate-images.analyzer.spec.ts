import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { DuplicateImagesAnalyzer } from './duplicate-images.analyzer.js';

const analyzer = new DuplicateImagesAnalyzer();
const settings = makeSettings();

describe('DuplicateImagesAnalyzer', () => {
  it('se déclare NON APPLICABLE sans image', async () => {
    const result = await analyzer.analyze(makePage('<p>Texte</p>'), settings);

    expect(result.status).toBe('na');
  });

  it('ne signale rien quand chaque image est unique', async () => {
    const result = await analyzer.analyze(
      makePage('<img src="/a.jpg"><img src="/b.jpg">'),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'DUP.no_duplicates')).toBe(true);
  });

  it('AVERTIT sur une image répétée', async () => {
    const result = await analyzer.analyze(
      makePage('<main><img src="/banniere.jpg"><img src="/banniere.jpg"></main>'),
      settings,
    );

    expect(result.status).toBe('warning');
    expect(result.items.some(item => item.key === 'DUP.duplicates')).toBe(true);
  });

  describe('logos', () => {
    it('TOLÈRE un logo répété en en-tête et en pied de page', async () => {
      // Un logo présent aux deux extrémités de la page est la norme, pas un
      // défaut : le sanctionner ferait échouer tous les sites.
      const result = await analyzer.analyze(
        makePage(
          '<header><img src="/marque.png" alt="Logo"></header><footer><img src="/marque.png" alt="Logo"></footer>',
        ),
        settings,
      );

      expect(result.status).toBe('pass');
      expect(result.items.some(item => item.key === 'DUP.logos')).toBe(true);
    });

    it('le reconnaît à son URL', async () => {
      const result = await analyzer.analyze(
        makePage('<div><img src="/img/logo-v2.png"></div><div><img src="/img/logo-v2.png"></div>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'DUP.logos')).toBe(true);
    });

    it('le reconnaît à sa seule position dans l’en-tête', async () => {
      const result = await analyzer.analyze(
        makePage(
          '<header><img src="/marque.png"></header><header><img src="/marque.png"></header>',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'DUP.logos')).toBe(true);
    });
  });

  it('normalise les paramètres d’URL avant de comparer', async () => {
    // `/photo.jpg?v=1` et `/photo.jpg?v=2` sont la même image.
    const result = await analyzer.analyze(
      makePage('<main><img src="/photo.jpg?v=1"><img src="/photo.jpg?v=2"></main>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'DUP.duplicates')).toBe(true);
  });

  it('inspecte aussi les images de fond en style en ligne', async () => {
    const result = await analyzer.analyze(
      makePage(
        '<main><div style="background-image: url(/fond.jpg)"></div><div style="background-image:url(\'/fond.jpg\')"></div></main>',
      ),
      settings,
    );

    expect(result.items.some(item => item.key === 'DUP.duplicates')).toBe(true);
  });

  it('ignore les images encodées dans la page', async () => {
    const result = await analyzer.analyze(
      makePage('<img src="data:image/gif;base64,AA"><img src="data:image/gif;base64,AA">'),
      settings,
    );

    expect(result.status).toBe('na');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<img src="/a.jpg">'),
      makeSettings({ disabledChecks: ['DUPLICATE_IMAGES'] }),
    );

    expect(result.status).toBe('na');
  });
});
