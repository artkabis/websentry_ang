import { describe, expect, it } from 'vitest';
import {
  auditPageContrast,
  evaluateElementContrast,
  resolveEffectiveBackground,
} from './contrast-resolver.js';
import { buildCSSOM } from './micro-cssom.js';

function page(css: string, body: string): string {
  return `<html><head><style>${css}</style></head><body>${body}</body></html>`;
}

/** Premier élément correspondant au sélecteur, dans un CSSOM construit. */
function elementOf(html: string, selector: string) {
  const cssom = buildCSSOM(html);
  const element = cssom.$(selector).get(0);
  if (!element) throw new Error(`Aucun élément pour « ${selector} »`);
  return { cssom, element };
}

describe('fond effectif', () => {
  it('rend le blanc quand aucun ancêtre n’en déclare', () => {
    const { cssom, element } = elementOf(page('', '<p>x</p>'), 'p');

    expect(resolveEffectiveBackground(element, cssom)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('rend le fond de l’élément lui-même', () => {
    const { cssom, element } = elementOf(page('p { background: #ff0000; }', '<p>x</p>'), 'p');

    expect(resolveEffectiveBackground(element, cssom)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it('REMONTE aux ancêtres à travers un élément transparent', () => {
    // Le fond ne s'hérite pas au sens CSS : il se VOIT au travers. Confondre
    // les deux donnerait du blanc là où le visiteur voit du noir.
    const { cssom, element } = elementOf(
      page('.sombre { background: #000000; }', '<div class="sombre"><span><p>x</p></span></div>'),
      'p',
    );

    expect(resolveEffectiveBackground(element, cssom)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it('COMPOSE les couches semi-transparentes', () => {
    const { cssom, element } = elementOf(
      page(
        '.fond { background: #000000; } .voile { background: rgba(255,255,255,0.5); }',
        '<div class="fond"><div class="voile"><p>x</p></div></div>',
      ),
      'p',
    );

    const background = resolveEffectiveBackground(element, cssom);
    expect(background.r).toBeGreaterThan(100);
    expect(background.r).toBeLessThan(160);
  });

  it('honore une couleur de fond par défaut fournie', () => {
    const { cssom, element } = elementOf(page('', '<p>x</p>'), 'p');
    const dark = { r: 0, g: 0, b: 0, a: 1 };

    expect(resolveEffectiveBackground(element, cssom, { defaultBg: dark })).toEqual(dark);
  });

  it('mémorise le résultat d’un élément déjà résolu', () => {
    // Un cache est indispensable : sans lui, chaque texte d'une page profonde
    // referait toute la remontée d'ancêtres.
    const { cssom, element } = elementOf(page('p { background: #ff0000; }', '<p>x</p>'), 'p');
    const cache = new Map();

    const first = resolveEffectiveBackground(element, cssom, {}, cache);
    const second = resolveEffectiveBackground(element, cssom, {}, cache);

    expect(second).toBe(first);
  });
});

describe('évaluation d’un élément', () => {
  it('déclare conforme un noir sur blanc', () => {
    const { cssom, element } = elementOf(
      page('p { color: #000; background: #fff; }', '<p>x</p>'),
      'p',
    );

    const result = evaluateElementContrast(element, cssom);
    expect(result.AA).toBe(true);
    expect(result.AAA).toBe(true);
    expect(result.ratio).toBeCloseTo(21, 0);
  });

  it('déclare non conforme un gris clair sur blanc', () => {
    const { cssom, element } = elementOf(
      page('p { color: #cccccc; background: #fff; }', '<p>x</p>'),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).AA).toBe(false);
  });

  it('reconnaît un GRAND texte par sa taille', () => {
    const { cssom, element } = elementOf(
      page('p { color: #000; font-size: 32px; }', '<p>x</p>'),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).isLarge).toBe(true);
  });

  it('reconnaît un grand texte gras à partir d’une taille moindre', () => {
    // WCAG abaisse le seuil dès 18,66 px en gras : l'ignorer ferait échouer
    // des titres pourtant conformes.
    const { cssom, element } = elementOf(
      page('p { color: #000; font-size: 19px; font-weight: bold; }', '<p>x</p>'),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).isLarge).toBe(true);
  });

  it('SIGNALE un fond en image au lieu de conclure', () => {
    const { cssom, element } = elementOf(
      page('p { color: #888; background-image: url(/fond.jpg); }', '<p>x</p>'),
      'p',
    );

    const result = evaluateElementContrast(element, cssom);
    expect(result.hasBgImage).toBe(true);
    expect(result.needsManualReview).toBe(true);
  });

  it('applique l’opacité de l’élément à sa couleur de texte', () => {
    const opaque = elementOf(page('p { color: #000; background: #fff; }', '<p>x</p>'), 'p');
    const faded = elementOf(
      page('p { color: #000; background: #fff; opacity: 0.3; }', '<p>x</p>'),
      'p',
    );

    const strong = evaluateElementContrast(opaque.element, opaque.cssom).ratio;
    const weak = evaluateElementContrast(faded.element, faded.cssom).ratio;
    expect(weak).toBeLessThan(strong);
  });
});

describe('fonds en dégradé', () => {
  it('MESURE le contraste contre un dégradé simple', () => {
    // Un dégradé a des couleurs connues : renoncer à conclure ferait passer en
    // « à vérifier » la moitié des sites modernes, où le dégradé est partout.
    const { cssom, element } = elementOf(
      page(
        'p { color: #fff; background-image: linear-gradient(to right, #000, #333); }',
        '<p>x</p>',
      ),
      'p',
    );

    const result = evaluateElementContrast(element, cssom);
    expect(result.needsManualReview).toBe(false);
    expect(result.AA).toBe(true);
  });

  it('retient le PIRE stop du dégradé', () => {
    // Un texte lisible sur une extrémité et illisible sur l'autre doit être
    // signalé : le visiteur voit les deux.
    const { cssom, element } = elementOf(
      page(
        'p { color: #ffffff; background-image: linear-gradient(to right, #000000, #ffffff); }',
        '<p>x</p>',
      ),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).AA).toBe(false);
  });

  it('renonce devant un dégradé à plusieurs couches', () => {
    const { cssom, element } = elementOf(
      page(
        'p { color: #888; background-image: linear-gradient(#000, #111), linear-gradient(#222, #333); }',
        '<p>x</p>',
      ),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).needsManualReview).toBe(true);
  });

  it('renonce devant un dégradé mêlé d’une image', () => {
    const { cssom, element } = elementOf(
      page('p { color: #888; background-image: linear-gradient(#000, url(/x.png)); }', '<p>x</p>'),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).needsManualReview).toBe(true);
  });

  it('ignore les indications de direction et de position', () => {
    const { cssom, element } = elementOf(
      page(
        'p { color: #fff; background-image: radial-gradient(circle at center, #000 0%, #111 100%); }',
        '<p>x</p>',
      ),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).needsManualReview).toBe(false);
  });

  it('PROPAGE un fond en image porté par un ancêtre', () => {
    // Le texte se lit sur l'image de son conteneur, pas sur du blanc : c'est
    // le même raisonnement que pour la couleur de fond.
    const { cssom, element } = elementOf(
      page(
        '.banniere { background-image: url(/fond.jpg); }',
        '<div class="banniere"><p>x</p></div>',
      ),
      'p',
    );

    expect(evaluateElementContrast(element, cssom).needsManualReview).toBe(true);
  });
});

describe('audit d’une page', () => {
  it('rend un résultat par élément textuel', async () => {
    const results = await auditPageContrast(
      page('p { color: #000; background: #fff; }', '<p>Un</p><p>Deux</p>'),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.tag).toBe('p');
  });

  it('IGNORE les éléments sans texte', async () => {
    const results = await auditPageContrast(page('', '<p></p><div></div><p>Du texte</p>'));

    expect(results).toHaveLength(1);
  });

  it('expose l’identifiant et les classes pour retrouver l’élément', async () => {
    const results = await auditPageContrast(page('', '<p id="intro" class="lead grand">Texte</p>'));

    expect(results[0]?.id).toBe('intro');
    expect(results[0]?.classes).toContain('lead');
  });

  it('BORNE le nombre d’éléments audités', async () => {
    // Une page de documentation peut porter des milliers de paragraphes :
    // sans plafond, l'analyse d'une seule page bloquerait le worker.
    const body = Array.from({ length: 30 }, (_, i) => `<p>Paragraphe ${i}</p>`).join('');
    const results = await auditPageContrast(page('', body), { maxElements: 5 });

    expect(results).toHaveLength(5);
  });

  it('honore un sélecteur d’audit fourni', async () => {
    const results = await auditPageContrast(page('', '<p>Un</p><h1>Titre</h1>'), {
      selector: 'h1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.tag).toBe('h1');
  });

  it('bascule sur fond NOIR quand la page déclare un thème sombre', async () => {
    // Sans cette détection, un texte clair sur thème sombre serait mesuré
    // contre du blanc et rapporté illisible alors qu'il ne l'est pas.
    const dark = await auditPageContrast(
      '<html><head><meta name="color-scheme" content="dark"><style>p{color:#eee}</style></head><body><p>Texte clair</p></body></html>',
    );

    expect(dark[0]?.AA).toBe(true);
  });

  it('rend une liste vide pour une page sans texte', async () => {
    expect(await auditPageContrast('<html><body><img src="/a.png"></body></html>')).toEqual([]);
  });
});
