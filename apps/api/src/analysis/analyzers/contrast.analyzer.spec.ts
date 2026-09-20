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

  it('NE TRANCHE PAS sur un fond en image', async () => {
    // Le contraste n'y est pas calculable : conclure accuserait au hasard.
    const result = await analyzer.analyze(
      styled(
        '.banniere { background-image: url(/fond.jpg); } p { color: #888; }',
        '<div class="banniere"><p>Texte sur une photo</p></div>',
      ),
      settings,
    );

    expect(result.items.some(item => item.key === 'CONTRAST_V2.review')).toBe(true);
    expect(result.status).toBe('pass');
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
