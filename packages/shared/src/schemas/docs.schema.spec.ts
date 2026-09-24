import { describe, expect, it } from 'vitest';
import {
  DocBlockSchema,
  DocInlineSchema,
  DocPageSchema,
  DocSearchQuerySchema,
  DocSearchResponseSchema,
  DocSlugSchema,
} from './docs.schema.js';

describe('DocInlineSchema', () => {
  it('accepte les quatre fragments', () => {
    for (const fragment of [
      { type: 'texte', texte: 'a' },
      { type: 'fort', texte: 'a' },
      { type: 'code', texte: 'a' },
      { type: 'lien', texte: 'a', href: 'doc:scans' },
      { type: 'lien', texte: 'a', href: 'https://exemple.fr/page' },
    ]) {
      expect(DocInlineSchema.safeParse(fragment).success).toBe(true);
    }
  });

  it('REFUSE une adresse dangereuse au niveau du SCHÉMA', () => {
    // La défense est doublée : l'analyseur ne produit pas ces liens, et le
    // schéma les refuserait même s'il le faisait.
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'http://exemple.fr',
      'doc:../../etc/passwd',
      'doc:MAJUSCULES',
    ]) {
      expect(DocInlineSchema.safeParse({ type: 'lien', texte: 'x', href }).success).toBe(false);
    }
  });

  it('REFUSE un fragment inventé', () => {
    expect(DocInlineSchema.safeParse({ type: 'html', texte: '<b>x</b>' }).success).toBe(false);
  });

  it('REFUSE une clé surnuméraire sur un fragment', () => {
    // C'est ainsi qu'un attribut `onclick` entrerait.
    expect(
      DocInlineSchema.safeParse({ type: 'texte', texte: 'x', onclick: 'alert(1)' }).success,
    ).toBe(false);
  });
});

describe('DocBlockSchema', () => {
  it('n’admet QUE les niveaux de titre 2 et 3', () => {
    // Le niveau 1 est le titre de la page, porté par l'en-tête de l'écran.
    const titre = (niveau: number) => ({ type: 'titre', niveau, texte: 'T', ancre: 't' });

    expect(DocBlockSchema.safeParse(titre(2)).success).toBe(true);
    expect(DocBlockSchema.safeParse(titre(3)).success).toBe(true);
    expect(DocBlockSchema.safeParse(titre(1)).success).toBe(false);
    expect(DocBlockSchema.safeParse(titre(4)).success).toBe(false);
  });

  it('EXIGE une ancre utilisable', () => {
    expect(
      DocBlockSchema.safeParse({ type: 'titre', niveau: 2, texte: 'T', ancre: '' }).success,
    ).toBe(false);
    expect(
      DocBlockSchema.safeParse({ type: 'titre', niveau: 2, texte: 'T', ancre: 'Deux Mots' })
        .success,
    ).toBe(false);
  });

  it('n’admet que deux tons d’encadré', () => {
    expect(DocBlockSchema.safeParse({ type: 'note', ton: 'info', contenu: [] }).success).toBe(true);
    expect(DocBlockSchema.safeParse({ type: 'note', ton: 'danger', contenu: [] }).success).toBe(
      false,
    );
  });

  it('REFUSE un bloc inventé', () => {
    expect(DocBlockSchema.safeParse({ type: 'iframe', src: 'https://x' }).success).toBe(false);
  });
});

describe('identifiant de page', () => {
  it('n’admet qu’un identifiant simple', () => {
    expect(DocSlugSchema.safeParse('premiers-pas').success).toBe(true);
    // Ce sont les formes qu'un chargeur de fichiers doit refuser.
    for (const slug of ['../secrets', 'a/b', 'Majuscule', 'espace ', 'a'.repeat(81)]) {
      expect(DocSlugSchema.safeParse(slug).success).toBe(false);
    }
  });
});

describe('recherche', () => {
  it('EXIGE au moins deux caractères', () => {
    // Une lettre seule ramènerait tout le portail, pour rien.
    expect(DocSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(DocSearchQuerySchema.parse({ q: 'ab' }).limit).toBe(20);
  });

  it('BORNE la limite et coupe les espaces', () => {
    expect(DocSearchQuerySchema.parse({ q: '  scan  ' }).q).toBe('scan');
    expect(DocSearchQuerySchema.safeParse({ q: 'scan', limit: 51 }).success).toBe(false);
    expect(DocSearchQuerySchema.parse({ q: 'scan', limit: '5' }).limit).toBe(5);
  });

  it('REFUSE un paramètre inconnu', () => {
    expect(DocSearchQuerySchema.safeParse({ q: 'scan', fichier: '../etc' }).success).toBe(false);
  });

  it('n’admet AUCUN balisage dans un extrait', () => {
    // L'extrait est du texte brut : renvoyer du balisage rouvrirait la porte
    // que la structure ferme.
    const hit = {
      slug: 'a',
      titre: 'T',
      section: 'S',
      ordre: 0,
      resume: 'r',
      extrait: 'du texte',
      score: 1,
      surbrillance: '<mark>x</mark>',
    };
    expect(DocSearchResponseSchema.safeParse({ q: 'x', resultats: [hit], total: 1 }).success).toBe(
      false,
    );
  });
});

describe('DocPageSchema', () => {
  it('n’admet AUCUN champ hors du contrat', () => {
    const page = {
      slug: 'a',
      titre: 'T',
      section: 'S',
      ordre: 0,
      resume: 'r',
      blocs: [],
      html: '<p>x</p>',
    };
    expect(DocPageSchema.safeParse(page).success).toBe(false);
  });
});
