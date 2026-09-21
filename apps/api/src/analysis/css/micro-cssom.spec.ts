import { describe, expect, it } from 'vitest';
import {
  MAX_EXTERNAL_SHEETS,
  buildCSSOM,
  fetchExternalCss,
  matchMedia,
  specificity,
  substituteVars,
} from './micro-cssom.js';

/** Style calculé du premier élément correspondant au sélecteur. */
function styleOf(html: string, selector: string, viewportWidth?: number) {
  const cssom = buildCSSOM(
    html,
    viewportWidth ? { viewport: { width: viewportWidth, height: 800 } } : {},
  );
  const element = cssom.$(selector).get(0);
  if (!element) throw new Error(`Aucun élément pour « ${selector} »`);
  return cssom.getComputedStyle(element);
}

function page(css: string, body: string): string {
  return `<html><head><style>${css}</style></head><body>${body}</body></html>`;
}

describe('cascade', () => {
  it('applique une règle simple', () => {
    expect(styleOf(page('p { color: red; }', '<p>x</p>'), 'p').color).toBe('red');
  });

  it('fait gagner le sélecteur le plus SPÉCIFIQUE, pas le dernier écrit', () => {
    const html = page('.rouge { color: red; } p { color: blue; }', '<p class="rouge">x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('départage deux règles de même spécificité par leur ORDRE', () => {
    const html = page('p { color: blue; } p { color: green; }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('fait gagner le style EN LIGNE sur la feuille', () => {
    const html = page('p { color: blue; }', '<p style="color: green">x</p>');

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('fait gagner !important sur tout le reste', () => {
    const html = page('p { color: blue !important; }', '<p style="color: green">x</p>');

    expect(styleOf(html, 'p').color).toBe('blue');
  });
});

describe('héritage', () => {
  it('transmet une propriété héritable', () => {
    const html = page('div { color: purple; }', '<div><p>x</p></div>');

    expect(styleOf(html, 'p').color).toBe('purple');
  });

  it('NE TRANSMET PAS une propriété non héritable', () => {
    // Le fond ne s'hérite pas : il se voit à travers un enfant transparent,
    // ce qui n'est pas la même chose et se calcule ailleurs.
    const html = page('div { background-color: red; }', '<div><p>x</p></div>');

    expect(styleOf(html, 'p')['background-color']).not.toBe('red');
  });

  it('honore le mot-clé inherit', () => {
    const html = page(
      'div { background-color: red; } p { background-color: inherit; }',
      '<div><p>x</p></div>',
    );

    expect(styleOf(html, 'p')['background-color']).toBe('red');
  });
});

describe('variables personnalisées', () => {
  it('résout une variable déclarée à la racine', () => {
    const html = page(':root { --ton: #123456; } p { color: var(--ton); }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('#123456');
  });

  it('résout une variable héritée d’un ancêtre', () => {
    const html = page(
      '.bloc { --ton: red; } p { color: var(--ton); }',
      '<div class="bloc"><p>x</p></div>',
    );

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('retombe sur la valeur de repli quand la variable manque', () => {
    const html = page('p { color: var(--absent, green); }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('substitue aussi dans une valeur composite', () => {
    const vars = new Map([['--ton', 'red']]);

    expect(substituteVars('1px solid var(--ton)', vars)).toBe('1px solid red');
  });

  it('rend la valeur inchangée sans variable à substituer', () => {
    expect(substituteVars('1px solid red', new Map())).toBe('1px solid red');
  });
});

describe('spécificité', () => {
  it('classe identifiant > classe > élément', () => {
    expect(specificity('#a')).toEqual([1, 0, 0]);
    expect(specificity('.a')).toEqual([0, 1, 0]);
    expect(specificity('a')).toEqual([0, 0, 1]);
  });

  it('additionne les composants d’un sélecteur', () => {
    expect(specificity('div.actif > p#cible')).toEqual([1, 1, 2]);
  });

  it('compte :not() par son ARGUMENT', () => {
    // La pseudo-classe ne pèse rien, mais ce qu'elle contient pèse : l'ignorer
    // ferait perdre des cascades entières.
    expect(specificity(':not(.a)')).toEqual([0, 1, 0]);
  });

  it('ne compte RIEN pour :where()', () => {
    expect(specificity(':where(.a, #b)')).toEqual([0, 0, 0]);
  });

  it('compte :is() par son argument le plus fort', () => {
    expect(specificity(':is(.a, #b)')).toEqual([1, 0, 0]);
  });

  it('compte un attribut comme une classe', () => {
    expect(specificity('[data-actif]')).toEqual([0, 1, 0]);
  });
});

describe('requêtes de média', () => {
  const viewport = { width: 1024, height: 768 };

  it('évalue une largeur minimale', () => {
    expect(matchMedia('(min-width: 768px)', viewport)).toBe(true);
    expect(matchMedia('(min-width: 1280px)', viewport)).toBe(false);
  });

  it('évalue une largeur maximale', () => {
    expect(matchMedia('(max-width: 1280px)', viewport)).toBe(true);
  });

  it('évalue la syntaxe par intervalle', () => {
    expect(matchMedia('(768px <= width <= 1280px)', viewport)).toBe(true);
    expect(matchMedia('(width > 2000px)', viewport)).toBe(false);
  });

  it('combine deux conditions', () => {
    expect(matchMedia('screen and (min-width: 768px)', viewport)).toBe(true);
    expect(matchMedia('(min-width: 768px) and (max-width: 800px)', viewport)).toBe(false);
  });

  it('accepte une liste de requêtes', () => {
    expect(matchMedia('(max-width: 400px), (min-width: 1000px)', viewport)).toBe(true);
  });

  it('écarte un média de type impression', () => {
    // Les styles d'impression ne décrivent pas ce que le visiteur voit :
    // les appliquer fausserait toute mesure de contraste.
    expect(matchMedia('print', viewport)).toBe(false);
  });

  it('applique une règle sous média au style calculé', () => {
    const html = page(
      'p { color: blue; } @media (min-width: 900px) { p { color: red; } }',
      '<p>x</p>',
    );

    expect(styleOf(html, 'p', 1200).color).toBe('red');
    expect(styleOf(html, 'p', 600).color).toBe('blue');
  });
});

describe('taille de police', () => {
  it('résout une taille relative à son parent', () => {
    const html = page('div { font-size: 20px; } p { font-size: 1.5em; }', '<div><p>x</p></div>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(30, 1);
  });

  it('résout une taille en rem depuis la racine', () => {
    const html = page('html { font-size: 20px; } p { font-size: 2rem; }', '<p>x</p>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(40, 1);
  });

  it('résout un pourcentage', () => {
    const html = page('div { font-size: 20px; } p { font-size: 50%; }', '<div><p>x</p></div>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(10, 1);
  });

  it('applique la feuille par défaut du navigateur', () => {
    // Sans elle, un <h1> aurait la taille d'un paragraphe et passerait pour du
    // texte courant — donc sous un seuil de contraste plus exigeant.
    const html = page('', '<h1>Titre</h1>');

    expect(styleOf(html, 'h1')._fontSizePx).toBeGreaterThan(16);
  });
});

describe('couches et règles conditionnelles', () => {
  it('applique une règle déclarée dans une couche', () => {
    const html = page('@layer base { p { color: red; } }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('fait gagner la couche DÉCLARÉE en dernier', () => {
    // L'ordre des couches prime sur la spécificité : c'est tout l'intérêt de
    // `@layer`, et l'ignorer inverserait le résultat sur les thèmes modernes.
    const html = page(
      '@layer base, theme; @layer theme { p { color: green; } } @layer base { p { color: red; } }',
      '<p>x</p>',
    );

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('fait gagner une règle HORS couche sur une règle en couche', () => {
    const html = page('@layer base { p { color: red; } } p { color: blue; }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('blue');
  });

  it('applique le contenu d’un @supports', () => {
    const html = page('@supports (display: grid) { p { color: red; } }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('applique le contenu d’un @container', () => {
    const html = page('@container (min-width: 100px) { p { color: red; } }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });
});

describe('tailles de police particulières', () => {
  it('reconnaît les mots-clés absolus', () => {
    const html = page('p { font-size: x-large; }', '<p>x</p>');

    expect(styleOf(html, 'p')._fontSizePx).toBeGreaterThan(16);
  });

  it('reconnaît larger et smaller', () => {
    const larger = page('div { font-size: 20px; } p { font-size: larger; }', '<div><p>x</p></div>');
    const smaller = page(
      'div { font-size: 20px; } p { font-size: smaller; }',
      '<div><p>x</p></div>',
    );

    expect(styleOf(larger, 'p')._fontSizePx).toBeGreaterThan(20);
    expect(styleOf(smaller, 'p')._fontSizePx).toBeLessThan(20);
  });

  it('résout clamp() par son MINIMUM', () => {
    // Approximation conservative : la typographie fluide est partout, et
    // retenir la borne basse ne surestime jamais la taille — donc jamais le
    // seuil de contraste allégé.
    const html = page('p { font-size: clamp(14px, 2vw, 32px); }', '<p>x</p>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(14, 1);
  });

  it('résout une taille en unités de viewport', () => {
    const html = page('p { font-size: 2vw; }', '<p>x</p>');

    expect(styleOf(html, 'p')._fontSizePx).toBeGreaterThan(16);
  });

  it('résout une taille en points', () => {
    const html = page('p { font-size: 12pt; }', '<p>x</p>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(16, 0);
  });

  it('retombe sur la taille du parent pour une valeur illisible', () => {
    const html = page('div { font-size: 20px; } p { font-size: nawak; }', '<div><p>x</p></div>');

    expect(styleOf(html, 'p')._fontSizePx).toBeCloseTo(20, 1);
  });
});

describe('spécificité — formes fonctionnelles', () => {
  it('compte :nth-child() comme une classe', () => {
    expect(specificity('p:nth-child(2)')).toEqual([0, 1, 1]);
  });

  it('ajoute la spécificité du « of » d’un :nth-child()', () => {
    expect(specificity(':nth-child(2 of .actif)')).toEqual([0, 2, 0]);
  });

  it('compte :has() par son argument', () => {
    expect(specificity('p:has(.actif)')).toEqual([0, 1, 1]);
  });

  it('compte un pseudo-élément comme un élément', () => {
    expect(specificity('p::before')).toEqual([0, 0, 2]);
  });

  it('compte une pseudo-classe ordinaire comme une classe', () => {
    expect(specificity('a:hover')).toEqual([0, 1, 1]);
  });
});

describe('propriétés raccourcies', () => {
  it('extrait la couleur d’un background composite', () => {
    const html = page('p { background: #ff0000 url(/x.png) no-repeat; }', '<p>x</p>');

    expect(styleOf(html, 'p')['background-color']).toBe('#ff0000');
  });

  it('extrait la graisse d’un font composite, en valeur numérique', () => {
    // `bold` est normalisé en `700` : le seuil de « grand texte » se compare à
    // un nombre, et le laisser en mot-clé le rendrait incomparable.
    const html = page('p { font: bold 16px/1.5 Arial; }', '<p>x</p>');

    expect(styleOf(html, 'p')['font-weight']).toBe('700');
  });
});

describe('mot-clé currentcolor', () => {
  it('rend la couleur de l’élément sur une autre propriété', () => {
    // Un fond en `currentcolor` vaut la couleur du texte : le laisser tel quel
    // rendrait le fond illisible pour la mesure de contraste.
    const html = page('p { color: #ff0000; background-color: currentcolor; }', '<p>x</p>');

    expect(styleOf(html, 'p')['background-color']).toBe('#ff0000');
  });

  it('vaut HÉRITAGE quand il porte sur la couleur elle-même', () => {
    // `color: currentcolor` ne peut pas se référer à elle-même : la spec la
    // ramène à l'héritage. La résoudre sur la valeur initiale rendrait du noir
    // là où le visiteur voit la couleur du parent.
    const html = page(
      '.parent { color: #00ff00; } p { color: currentcolor; }',
      '<div class="parent"><p>x</p></div>',
    );

    expect(styleOf(html, 'p').color).toBe('#00ff00');
  });
});

describe('résolution des sélecteurs', () => {
  // Les règles d'une feuille ne sont plus cherchées dans tout le document :
  // elles passent par un index des classes, identifiants et balises présents.
  // Chaque forme de sélecteur doit continuer à désigner exactement les mêmes
  // éléments — une règle perdue, c'est une couleur fausse, donc un verdict faux.

  it('applique une règle de CLASSE seule', () => {
    expect(styleOf(page('.promo { color: red; }', '<p class="promo">x</p>'), 'p').color).toBe(
      'red',
    );
  });

  it('applique une règle d’IDENTIFIANT seul', () => {
    expect(styleOf(page('#intro { color: red; }', '<p id="intro">x</p>'), 'p').color).toBe('red');
  });

  it('applique une règle de BALISE seule', () => {
    expect(styleOf(page('p { color: red; }', '<p>x</p>'), 'p').color).toBe('red');
  });

  it('applique un sélecteur COMPOSÉ', () => {
    const html = page('p.promo { color: red; }', '<p class="promo">x</p><p>y</p>');

    expect(styleOf(html, 'p.promo').color).toBe('red');
    expect(styleOf(html, 'p:not(.promo)').color).not.toBe('red');
  });

  it('applique un sélecteur DESCENDANT', () => {
    const html = page('.cadre p { color: red; }', '<div class="cadre"><span><p>x</p></span></div>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('n’applique PAS un descendant dont l’ancêtre manque', () => {
    const html = page('.absent p { color: red; }', '<div class="cadre"><p>x</p></div>');

    expect(styleOf(html, 'p').color).not.toBe('red');
  });

  it('applique un sélecteur d’ENFANT direct', () => {
    const html = page(
      '.cadre > p { color: red; }',
      '<div class="cadre"><p>direct</p><span><p>indirect</p></span></div>',
    );

    expect(styleOf(html, 'p').color).toBe('red');
    expect(styleOf(html, 'span p').color).not.toBe('red');
  });

  it('applique un sélecteur d’ATTRIBUT', () => {
    const html = page('[data-ton="sombre"] { color: red; }', '<p data-ton="sombre">x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('applique un sélecteur UNIVERSEL', () => {
    expect(styleOf(page('* { color: red; }', '<p>x</p>'), 'p').color).toBe('red');
  });

  it('applique une pseudo-classe FONCTIONNELLE', () => {
    const html = page(':is(.a, .b) { color: red; }', '<p class="b">x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('applique une classe ÉCHAPPÉE', () => {
    // `md\:flex`, `w-1\/2` : les utilitaires modernes en produisent en masse.
    // Lire la clé naïvement donnerait « md », classe absente du document, et la
    // règle serait écartée à tort.
    const html = page('.md\\:flex { color: red; }', '<p class="md:flex">x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('n’applique rien quand la classe visée est absente', () => {
    const html = page('.absente { color: red; } p { color: green; }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('PRÉSERVE l’ordre de cascade malgré les règles écartées', () => {
    // Une règle qui ne vise personne n'est plus cherchée, mais elle compte
    // toujours dans la numérotation : à spécificité égale, c'est la DERNIÈRE
    // déclarée qui gagne, et décaler les numéros ferait gagner l'autre.
    const html = page(
      '.promo { color: red; } .absente { color: blue; } .promo { color: green; }',
      '<p class="promo">x</p>',
    );

    expect(styleOf(html, 'p').color).toBe('green');
  });

  it('applique une règle à TOUS les éléments visés, pas au premier', () => {
    const html = page('.promo { color: red; }', '<p class="promo">un</p><p class="promo">deux</p>');
    const cssom = buildCSSOM(html);
    const couleurs = cssom
      .$('p')
      .toArray()
      .map(element => cssom.getComputedStyle(element).color);

    expect(couleurs).toEqual(['red', 'red']);
  });
});

describe('robustesse', () => {
  it('ignore une règle syntaxiquement invalide sans perdre les suivantes', () => {
    const html = page('p { color: ; } p { color: red; }', '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('red');
  });

  it('survit à une feuille vide', () => {
    expect(() => buildCSSOM(page('', '<p>x</p>'))).not.toThrow();
  });

  it('survit à un document sans style', () => {
    expect(() => buildCSSOM('<html><body><p>x</p></body></html>')).not.toThrow();
  });
});

describe('feuilles externes', () => {
  /** Lecteur simulé : rend le texte associé à l’URL, ou échoue. */
  function reader(sheets: Record<string, string>) {
    const seen: string[] = [];
    const impl = (url: string) => {
      seen.push(url);
      const css = sheets[url];
      return Promise.resolve({ ok: css !== undefined, text: () => Promise.resolve(css ?? '') });
    };
    return { impl, seen };
  }

  function linked(...hrefs: string[]): string {
    const links = hrefs.map(href => `<link rel="stylesheet" href="${href}">`).join('');
    return `<html><head>${links}</head><body><p>x</p></body></html>`;
  }

  it('NE SORT PAS sans lecteur fourni, mais compte ce qui est déclaré', async () => {
    // Le moteur n'a pas de porte de sortie à lui : l'absence de lecteur est un
    // refus de sortir, pas une absence de feuilles. Confondre les deux ferait
    // conclure sur des valeurs par défaut sans le signaler.
    const external = await fetchExternalCss(linked('/charte.css'), { baseUrl: 'https://x.fr/' });

    expect(external.sheets).toEqual({});
    expect(external.declared).toBe(1);
    expect(external.loaded).toBe(0);
  });

  it('résout une URL relative contre l’adresse de la page', async () => {
    const { impl, seen } = reader({ 'https://x.fr/pages/css/charte.css': 'p { color: red; }' });

    const external = await fetchExternalCss(linked('css/charte.css'), {
      baseUrl: 'https://x.fr/pages/',
      fetchImpl: impl,
    });

    expect(seen).toEqual(['https://x.fr/pages/css/charte.css']);
    // La clé reste le href TEL QUE DÉCLARÉ : c'est par lui que la cascade
    // retrouve la feuille dans le document.
    expect(external.sheets['css/charte.css']).toBe('p { color: red; }');
    expect(external.loaded).toBe(1);
  });

  it('compte comme NON LUE une feuille que le lecteur refuse', async () => {
    const { impl } = reader({});

    const external = await fetchExternalCss(linked('/charte.css'), {
      baseUrl: 'https://x.fr/',
      fetchImpl: impl,
    });

    expect(external.declared).toBe(1);
    expect(external.loaded).toBe(0);
  });

  it('ne laisse pas une URL illisible emporter les feuilles suivantes', async () => {
    const { impl } = reader({ 'https://x.fr/charte.css': 'p { color: red; }' });

    const external = await fetchExternalCss(linked('http://[invalide', '/charte.css'), {
      baseUrl: 'https://x.fr/',
      fetchImpl: impl,
    });

    expect(external.declared).toBe(2);
    expect(external.loaded).toBe(1);
  });

  it('PLAFONNE le nombre de sorties, et garde les premières déclarées', async () => {
    // Une page qui déclare trente feuilles met sa charte au début : c'est là
    // que se joue le contraste, pas dans la trentième surcharge.
    const hrefs = Array.from({ length: MAX_EXTERNAL_SHEETS + 4 }, (_, i) => `/f${i}.css`);
    const sheets = Object.fromEntries(hrefs.map(href => [`https://x.fr${href}`, 'p{color:red}']));
    const { impl, seen } = reader(sheets);

    const external = await fetchExternalCss(linked(...hrefs), {
      baseUrl: 'https://x.fr/',
      fetchImpl: impl,
    });

    expect(seen).toHaveLength(MAX_EXTERNAL_SHEETS);
    expect(seen).toContain('https://x.fr/f0.css');
    expect(seen).not.toContain(`https://x.fr/f${MAX_EXTERNAL_SHEETS}.css`);
    expect(external.declared).toBe(MAX_EXTERNAL_SHEETS + 4);
    expect(external.loaded).toBe(MAX_EXTERNAL_SHEETS);
  });

  it('ignore un lien qui n’est pas une feuille de style', async () => {
    const { impl, seen } = reader({});
    const html =
      '<html><head><link rel="icon" href="/favicon.ico"><link rel="preload" href="/a.css"></head><body><p>x</p></body></html>';

    const external = await fetchExternalCss(html, { baseUrl: 'https://x.fr/', fetchImpl: impl });

    expect(seen).toEqual([]);
    expect(external.declared).toBe(0);
  });
});

describe('mémorisation des feuilles', () => {
  // Une charte est la même sur toutes les pages d'un site : elle n'est découpée
  // qu'une fois. Ce qui suit vérifie que la réutilisation ne transporte RIEN
  // d'une page à l'autre.
  const CHARTE = '.promo { color: red; } p { color: blue; }';

  it('rend le même verdict sur deux pages qui partagent la feuille', () => {
    const premiere = page(CHARTE, '<p class="promo">un</p>');
    const seconde = page(CHARTE, '<p>deux</p>');

    expect(styleOf(premiere, 'p').color).toBe('red');
    expect(styleOf(seconde, 'p').color).toBe('blue');
  });

  it('ne laisse pas la première page figer les styles de la seconde', () => {
    // Les règles mémorisées sont PARTAGÉES : si l'une des deux constructions
    // les modifiait, l'autre lirait des valeurs qui ne sont pas les siennes.
    const cssomA = buildCSSOM(page(CHARTE, '<p class="promo">un</p>'));
    const cssomB = buildCSSOM(page(CHARTE, '<p>deux</p>'));

    const lire = (cssom: ReturnType<typeof buildCSSOM>) =>
      cssom.getComputedStyle(cssom.$('p').get(0)!).color;

    expect(lire(cssomB)).toBe('blue');
    // Relu APRÈS la seconde construction : la première doit être intacte.
    expect(lire(cssomA)).toBe('red');
  });

  it('rejoue le filtrage @media à chaque page, jamais le verdict de la précédente', () => {
    // Le découpage est mémorisé, pas la DÉCISION. La variable est lue sans
    // repli : si la règle écartée par le viewport versait quand même sa
    // palette au registre, la couleur se résoudrait au lieu de rester à sa
    // valeur initiale — c'est précisément ce que ce test interdit.
    const css =
      '@media (max-width: 768px) { :root { --teinte: red; } } p { color: var(--teinte); }';
    const html = page(css, '<p>x</p>');

    expect(styleOf(html, 'p', 375).color).toBe('red');
    expect(styleOf(html, 'p', 1400).color).toBe('rgb(0, 0, 0)');
    expect(styleOf(html, 'p', 375).color).toBe('red');
  });

  // Deux couches anonymes, dont la PREMIÈRE est la plus spécifique : c'est le
  // seul montage où la fusion des deux couches se voit. À couches distinctes,
  // la dernière déclarée gagne malgré sa moindre spécificité ; fusionnées, la
  // spécificité reprend la main et la première gagne à tort.
  const ANONYMES = `<html><head>
      <style>@layer { p.promo { color: red; } }</style>
      <style>@layer { p { color: green; } }</style>
    </head><body><p class="promo">x</p></body></html>`;

  it('GARDE DISTINCTES deux couches anonymes de la même page', () => {
    expect(styleOf(ANONYMES, 'p').color).toBe('green');
  });

  it('nomme les couches anonymes à l’identique d’une page à l’autre', () => {
    // Deux constructions successives : la seconde ne doit pas hériter du
    // compteur de la première, ni d'un découpage mémorisé.
    expect(styleOf(ANONYMES, 'p').color).toBe('green');
    expect(styleOf(ANONYMES, 'p').color).toBe('green');
  });

  it('conserve l’ordre des couches NOMMÉES au fil des réutilisations', () => {
    const css =
      '@layer base, theme; @layer theme { p { color: green; } } @layer base { p { color: red; } }';
    const html = page(css, '<p>x</p>');

    expect(styleOf(html, 'p').color).toBe('green');
    expect(styleOf(html, 'p').color).toBe('green');
  });
});
