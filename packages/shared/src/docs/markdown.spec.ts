import { describe, expect, it } from 'vitest';
import { DocPageSchema } from '../schemas/docs.schema.js';
import {
  analyserBlocs,
  analyserEnLigne,
  analyserPage,
  ancrer,
  resumerBlocs,
  separerEntete,
  texteBrut,
} from './markdown.js';

describe('en-tête', () => {
  it('lit titre, section et ordre', () => {
    const { entete, corps } = separerEntete(
      '---\ntitre: Premiers pas\nsection: Prise en main\nordre: 2\n---\nDu texte.',
    );

    expect(entete).toEqual({ titre: 'Premiers pas', section: 'Prise en main', ordre: 2 });
    expect(corps.trim()).toBe('Du texte.');
  });

  it('retombe sur les DÉFAUTS sans en-tête', () => {
    const { entete, corps } = separerEntete('Juste du texte.');

    expect(entete.titre).toBe('Sans titre');
    expect(corps).toBe('Juste du texte.');
  });

  it('traite un en-tête JAMAIS refermé comme du corps', () => {
    // Un en-tête ouvert et non clos n'est pas un en-tête : avaler tout le
    // fichier ferait disparaître la page.
    const { entete, corps } = separerEntete('---\ntitre: Oublié\nDu texte.');

    expect(entete.titre).toBe('Sans titre');
    expect(corps).toContain('Du texte.');
  });

  it('IGNORE une clé inconnue et un ordre absurde', () => {
    const { entete } = separerEntete('---\ntitre: T\nauteur: quelqu’un\nordre: -3\n---\n');

    expect(entete.ordre).toBe(0);
    expect(entete).not.toHaveProperty('auteur');
  });

  it('accepte un deux-points dans la valeur', () => {
    const { entete } = separerEntete('---\ntitre: WebSentry : prise en main\n---\n');
    expect(entete.titre).toBe('WebSentry : prise en main');
  });

  it('IGNORE une ligne d’en-tête sans deux-points', () => {
    // Une ligne mal tapée ne doit ni casser l'analyse, ni devenir une clé.
    const { entete } = separerEntete('---\ntitre: T\nligne sans separateur\n---\n');
    expect(entete.titre).toBe('T');
  });

  it('accepte les fins de ligne Windows', () => {
    const { entete } = separerEntete('---\r\ntitre: Windows\r\n---\r\nTexte.');
    expect(entete.titre).toBe('Windows');
  });
});

describe('ancres', () => {
  it('retire accents et ponctuation', () => {
    expect(ancrer('Réglages avancés')).toBe('reglages-avances');
    expect(ancrer('Qu’est-ce qu’un scan ?')).toBe('qu-est-ce-qu-un-scan');
  });

  it('ne rend JAMAIS une ancre vide', () => {
    // Le schéma la refuserait, et le sommaire perdrait sa cible.
    expect(ancrer('???')).toBe('section');
    expect(ancrer('')).toBe('section');
  });
});

describe('fragments en ligne', () => {
  it('reconnaît le gras, le code et les liens', () => {
    const fragments = analyserEnLigne(
      'Un **mot** et du `code` puis [la page](doc:scans) et [le site](https://exemple.fr).',
    );

    expect(fragments.map(f => f.type)).toEqual([
      'texte',
      'fort',
      'texte',
      'code',
      'texte',
      'lien',
      'texte',
      'lien',
      'texte',
    ]);
  });

  it('REFUSE une adresse dangereuse, en gardant le texte VISIBLE', () => {
    // Un `javascript:` n'est pas « nettoyé » : il ne produit simplement aucun
    // lien, et la syntaxe reste lisible à l'écran.
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'http://exemple.fr']) {
      const fragments = analyserEnLigne(`Voir [ici](${href}).`);

      expect(fragments.every(f => f.type !== 'lien')).toBe(true);
      expect(fragments.map(f => f.texte).join('')).toContain(href);
    }
  });

  it('REFUSE une page interne mal formée', () => {
    const fragments = analyserEnLigne('Voir [ici](doc:../../etc/passwd).');
    expect(fragments.every(f => f.type !== 'lien')).toBe(true);
  });

  it('rend le texte TEL QUEL quand rien n’est reconnu', () => {
    expect(analyserEnLigne('Texte simple.')).toEqual([{ type: 'texte', texte: 'Texte simple.' }]);
  });

  it('laisse une syntaxe incomplète EN TEXTE', () => {
    // Une syntaxe mal tapée doit se voir, pas s'évaporer.
    const fragments = analyserEnLigne('Un **gras jamais fermé et un `code aussi');
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.type).toBe('texte');
  });

  it('reconnaît un fragment placé en TÊTE de ligne', () => {
    // Sans ce cas, le premier fragment d'un paragraphe ne serait jamais
    // éprouvé — et c'est exactement là qu'une erreur de curseur se loge.
    const fragments = analyserEnLigne('**Attention** au début.');

    expect(fragments[0]).toEqual({ type: 'fort', texte: 'Attention' });
    expect(fragments).toHaveLength(2);
  });

  it('rend une liste vide sur une chaîne vide', () => {
    expect(analyserEnLigne('')).toEqual([]);
  });
});

describe('blocs', () => {
  it('reconnaît titres, paragraphes, listes, code et encadrés', () => {
    const blocs = analyserBlocs(
      [
        '## Un titre',
        '',
        'Un paragraphe',
        'sur deux lignes.',
        '',
        '- premier',
        '- second',
        '',
        '1. un',
        '2. deux',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '> Note: ceci est un encadré.',
        '',
        '> Attention: celui-ci avertit.',
      ].join('\n'),
    );

    expect(blocs.map(b => b.type)).toEqual([
      'titre',
      'paragraphe',
      'liste',
      'liste',
      'code',
      'note',
      'note',
    ]);
  });

  it('JOINT les lignes d’un même paragraphe', () => {
    const blocs = analyserBlocs('Une phrase\ncoupée en deux.');
    const paragraphe = blocs[0];

    expect(blocs).toHaveLength(1);
    expect(paragraphe?.type === 'paragraphe' && paragraphe.contenu[0]?.texte).toBe(
      'Une phrase coupée en deux.',
    );
  });

  it('distingue liste à puces et liste numérotée', () => {
    const blocs = analyserBlocs('- a\n\n1. b');
    expect(blocs[0]?.type === 'liste' && blocs[0].ordonnee).toBe(false);
    expect(blocs[1]?.type === 'liste' && blocs[1].ordonnee).toBe(true);
  });

  it('porte le LANGAGE d’un bloc de code, ou null', () => {
    const avec = analyserBlocs('```bash\npnpm test\n```');
    const sans = analyserBlocs('```\nbrut\n```');

    expect(avec[0]?.type === 'code' && avec[0].langage).toBe('bash');
    expect(sans[0]?.type === 'code' && sans[0].langage).toBeNull();
  });

  it('ne PERD PAS un bloc de code jamais refermé', () => {
    // Une clôture manquante ne doit pas faire disparaître la fin de la page.
    const blocs = analyserBlocs('```\nligne un\nligne deux');
    expect(blocs[0]?.type === 'code' && blocs[0].texte).toBe('ligne un\nligne deux');
  });

  it('n’interprète RIEN à l’intérieur d’un bloc de code', () => {
    const blocs = analyserBlocs('```\n## pas un titre\n- pas une liste\n```');
    expect(blocs).toHaveLength(1);
    expect(blocs[0]?.type).toBe('code');
  });

  it('donne une ancre à chaque titre', () => {
    const blocs = analyserBlocs('## Réglages avancés');
    expect(blocs[0]?.type === 'titre' && blocs[0].ancre).toBe('reglages-avances');
  });

  it('plafonne les titres au niveau 3', () => {
    // Au-delà, la hiérarchie ne se lit plus ; `####` n'est pas un titre.
    const blocs = analyserBlocs('#### Trop profond');
    expect(blocs[0]?.type).toBe('paragraphe');
  });

  it('rend un tableau VIDE sur un corps vide', () => {
    expect(analyserBlocs('')).toEqual([]);
    expect(analyserBlocs('\n\n   \n')).toEqual([]);
  });

  it('tient sur un document malformé, sans boucler', () => {
    const blocs = analyserBlocs('> \n>>\n#\n#####\n-\n```');
    expect(Array.isArray(blocs)).toBe(true);
  });
});

describe('résumé et texte brut', () => {
  it('prend la première phrase, jamais un titre', () => {
    const blocs = analyserBlocs('## Titre\n\nLa première phrase.\n\nUne seconde.');
    expect(resumerBlocs(blocs)).toBe('La première phrase.');
  });

  it('COUPE sur un espace, pas au milieu d’un mot', () => {
    const blocs = analyserBlocs(`${'mot '.repeat(60)}fin.`);
    const resume = resumerBlocs(blocs, 50);

    expect(resume.endsWith('…')).toBe(true);
    expect(resume).not.toMatch(/mo…$/);
  });

  it('COUPE net un mot unique trop long, faute d’espace', () => {
    // Sans espace où couper, mieux vaut trancher que rendre un résumé vide.
    const blocs = analyserBlocs('a'.repeat(200));
    const resume = resumerBlocs(blocs, 50);

    expect(resume).toHaveLength(51);
    expect(resume.endsWith('…')).toBe(true);
  });

  it('rend une chaîne vide sans aucun paragraphe', () => {
    expect(resumerBlocs(analyserBlocs('## Titre seul'))).toBe('');
  });

  it('indexe TOUS les blocs, code compris', () => {
    // Chercher un nom de commande doit trouver la page qui la montre.
    const blocs = analyserBlocs(
      '## Titre\n\nTexte.\n\n- élément\n\n```\npnpm db:init\n```\n\n> Note: un encadré.',
    );
    const brut = texteBrut(blocs);

    expect(brut).toContain('Titre');
    expect(brut).toContain('élément');
    expect(brut).toContain('pnpm db:init');
    expect(brut).toContain('un encadré');
  });
});

describe('page complète', () => {
  it('produit une page CONFORME au schéma partagé', () => {
    const page = analyserPage(
      'premiers-pas',
      [
        '---',
        'titre: Premiers pas',
        'section: Prise en main',
        'ordre: 1',
        '---',
        '',
        'WebSentry analyse un site et rend un **score**.',
        '',
        '## Lancer une analyse',
        '',
        'Ouvrez [la page d’analyse](doc:analyse).',
      ].join('\n'),
    );

    expect(() => DocPageSchema.parse(page)).not.toThrow();
    expect(page.titre).toBe('Premiers pas');
    expect(page.resume).toContain('WebSentry analyse');
  });

  it('produit une page conforme MÊME sur un fichier vide', () => {
    // Un fichier vide ne doit pas casser le chargement de tout le portail.
    const page = analyserPage('vide', '');

    expect(() => DocPageSchema.parse(page)).not.toThrow();
    expect(page.blocs).toEqual([]);
  });
});
