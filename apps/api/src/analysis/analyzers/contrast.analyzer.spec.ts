import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { ContrastAnalyzer } from './contrast.analyzer.js';

const analyzer = new ContrastAnalyzer();
const settings = makeSettings();

function styled(css: string, body: string) {
  return makePage(`<html><head><style>${css}</style></head><body>${body}</body></html>`);
}

describe('ContrastAnalyzer', () => {
  it('se déclare NON APPLICABLE sans texte à mesurer', async () => {
    const result = await analyzer.analyze(
      makePage('<div><img src="/a.png" alt="x"></div>'),
      settings,
    );

    expect(result.status).toBe('na');
  });

  it('valide un texte franchement lisible', async () => {
    const result = await analyzer.analyze(
      styled('p { color: #000; background: #fff; }', '<p>Texte parfaitement lisible</p>'),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'CONTRAST_V2.ok')).toBe(true);
  });

  it('ÉCHOUE sur un gris clair sur blanc', async () => {
    const result = await analyzer.analyze(
      styled('p { color: #bbb; background: #fff; }', '<p>Texte trop pâle pour être lu</p>'),
      settings,
    );

    expect(result.status).toBe('fail');
    const item = result.items.find(entry => entry.key === 'CONTRAST_V2.low');
    expect(item?.label).toContain('#bbbbbb');
    expect(item?.locator).toBeDefined();
  });

  it('résout la cascade — la règle la plus spécifique l’emporte', async () => {
    const result = await analyzer.analyze(
      styled(
        'p { color: #000; background: #fff; } .pale { color: #ccc; }',
        '<p class="pale">Texte pâle par une règle plus spécifique</p>',
      ),
      settings,
    );

    expect(result.status).toBe('fail');
  });

  it('suit une variable CSS', async () => {
    // Sans résolution des variables, la couleur resterait inconnue et le texte
    // passerait faute de mesure.
    const result = await analyzer.analyze(
      styled(
        ':root { --ton: #ddd; } p { color: var(--ton); background: #fff; }',
        '<p>Texte coloré par une variable</p>',
      ),
      settings,
    );

    expect(result.status).toBe('fail');
  });

  it('hérite la couleur de fond d’un ancêtre', async () => {
    // Le fond ne s'hérite pas au sens CSS : il se VOIT à travers un élément
    // transparent. Le confondre avec du blanc inverserait le verdict.
    const result = await analyzer.analyze(
      styled(
        '.sombre { background: #222; } p { color: #333; }',
        '<div class="sombre"><p>Texte sombre sur fond sombre</p></div>',
      ),
      settings,
    );

    expect(result.status).toBe('fail');
  });

  it('applique le seuil ALLÉGÉ au grand texte', async () => {
    // WCAG demande 3:1 et non 4,5:1 au-delà d'une certaine taille : appliquer
    // le seuil du texte courant ferait échouer des titres conformes.
    const large = await analyzer.analyze(
      styled(
        'h1 { color: #767676; background: #fff; font-size: 32px; }',
        '<h1>Un grand titre gris</h1>',
      ),
      settings,
    );
    const normal = await analyzer.analyze(
      styled(
        'p { color: #767676; background: #fff; font-size: 12px; }',
        '<p>Le même gris en texte courant</p>',
      ),
      settings,
    );

    expect(large.status).toBe('pass');
    expect(normal.items.find(item => item.key === 'CONTRAST_V2.ok')?.label).toContain('AA');
  });

  describe('textes non mesurables', () => {
    const surPhoto = () =>
      styled(
        '.banniere { background-image: url(/fond.jpg); } p { color: #888; }',
        '<div class="banniere"><p>Texte sur une photo</p></div>',
      );

    it('NE TRANCHE PAS sur un fond en image', async () => {
      // Le contraste n'y est pas calculable : conclure accuserait au hasard.
      const result = await analyzer.analyze(surPhoto(), settings);

      expect(result.items.some(item => item.key === 'CONTRAST_V2.review')).toBe(true);
    });

    it('les signale en INFO, pas en conforme', async () => {
      // Le filtre par défaut de l'écran masque les critères conformes : classer
      // ces textes « pass » ferait disparaître ce qui réclame justement un œil.
      const result = await analyzer.analyze(surPhoto(), settings);

      expect(result.items.find(item => item.key === 'CONTRAST_V2.review')?.status).toBe('info');
    });

    it('NE DÉCERNE AUCUNE NOTE quand rien n’a pu être mesuré', async () => {
      // Une page dont tous les textes sont posés sur des images sortait avec
      // 5 sur 5 : une note parfaite décernée sans une seule mesure.
      const result = await analyzer.analyze(surPhoto(), settings);

      expect(result.status).toBe('na');
      expect(result.summary).toContain('non mesurable');
    });

    it('mais note normalement dès qu’un texte est mesurable', async () => {
      const result = await analyzer.analyze(
        styled(
          '.banniere { background-image: url(/fond.jpg); } p { color: #000; background: #fff; }',
          '<div class="banniere"><span>Texte sur une photo</span></div><p>Texte lisible</p>',
        ),
        settings,
      );

      expect(result.status).toBe('pass');
      expect(result.globalScore).toBe(5);
    });

    it('ANNONCE qu’il s’est arrêté avant la fin d’une page très longue', async () => {
      // Taire le plafond laisserait conclure « conforme » sur des textes qui
      // n'ont jamais été regardés.
      const paragraphes = Array.from(
        { length: 450 },
        (_, index) => `<p>Paragraphe lisible numéro ${index}</p>`,
      ).join('');
      const result = await analyzer.analyze(
        styled('p { color: #000; background: #fff; }', paragraphes),
        settings,
      );

      const notice = result.items.find(item => item.label.includes('trop longue'));
      expect(notice?.status).toBe('info');
      expect(notice?.key).toBeUndefined();
    });
  });

  it('GROUPE les occurrences d’une même paire de couleurs', async () => {
    // Une page moderne répète la même faute des dizaines de fois : autant de
    // lignes identiques dans un rapport équivaut à n'en avoir aucune.
    const paragraphs = Array.from(
      { length: 5 },
      (_, index) => `<p>Paragraphe pâle numéro ${index}</p>`,
    ).join('');

    const result = await analyzer.analyze(
      styled('p { color: #bbb; background: #fff; }', paragraphs),
      settings,
    );

    const failures = result.items.filter(item => item.key === 'CONTRAST_V2.low');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain('5 occurrences');
  });

  it('retient le PIRE ratio d’un groupe', async () => {
    const result = await analyzer.analyze(
      styled(
        'p { background: #fff; } .a { color: #949494; } .b { color: #949494; opacity: 1; }',
        '<p class="a">Premier texte gris</p><p class="b">Second texte gris</p>',
      ),
      settings,
    );

    const item = result.items.find(entry => entry.key?.startsWith('CONTRAST_V2.'));
    expect(item?.label).toMatch(/\d+(\.\d+)?:1/);
  });

  it('garde un libellé STABLE, sans le décompte', async () => {
    // Le même défaut doit porter le même intitulé d'une page à l'autre, sans
    // quoi une vue multi-pages le compterait plusieurs fois.
    const single = await analyzer.analyze(
      styled('p { color: #bbb; background: #fff; }', '<p>Un seul paragraphe pâle</p>'),
      settings,
    );
    const many = await analyzer.analyze(
      styled('p { color: #bbb; background: #fff; }', '<p>Un</p><p>Deux</p><p>Trois</p>'),
      settings,
    );

    expect(single.items.find(item => item.key === 'CONTRAST_V2.low')?.label).toBe(
      many.items.find(item => item.key === 'CONTRAST_V2.low')?.label,
    );
  });

  it('note la PROPORTION de textes conformes', async () => {
    // Un défaut isolé parmi vingt textes ne vaut pas le même reproche qu'une
    // page entièrement illisible.
    const mostlyFine = await analyzer.analyze(
      styled(
        'p { color: #000; background: #fff; } .pale { color: #ccc; }',
        '<p>Un</p><p>Deux</p><p>Trois</p><p class="pale">Quatre</p>',
      ),
      settings,
    );
    const allBad = await analyzer.analyze(
      styled('p { color: #ccc; background: #fff; }', '<p>Un</p><p>Deux</p>'),
      settings,
    );

    expect(mostlyFine.globalScore).toBeGreaterThan(allBad.globalScore);
    expect(allBad.globalScore).toBe(0);
  });

  it('reconnaît un thème sombre déclaré', async () => {
    // Sans cette détection, le fond par défaut serait blanc et un texte clair
    // — parfaitement lisible sur fond noir — serait rapporté illisible.
    const result = await analyzer.analyze(
      makePage(
        '<html><head><meta name="color-scheme" content="dark"><style>p { color: #eee; }</style></head><body><p>Texte clair sur thème sombre</p></body></html>',
      ),
      settings,
    );

    expect(result.status).toBe('pass');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      styled('p { color: #bbb; background: #fff; }', '<p>Texte</p>'),
      makeSettings({ disabledChecks: ['CONTRAST_V2'] }),
    );

    expect(result.status).toBe('na');
  });
});
