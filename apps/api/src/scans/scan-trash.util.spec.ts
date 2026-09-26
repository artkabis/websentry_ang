import { describe, expect, it } from 'vitest';
import { decoderLigne, encoderLigne, libelleCorbeille } from './scan-trash.util.js';

describe('encoderLigne / decoderLigne', () => {
  it('fait l’aller-retour d’un rapport compressé SANS le dénaturer', () => {
    // Le cœur de ces fonctions : un `JSON.stringify` naïf rendrait le Buffer en
    // `{ type: 'Buffer', data: [ … ] }`, que la restauration réinsérerait tel
    // quel. La page restaurée aurait un rapport illisible, et rien ne l'aurait
    // signalé.
    const rapport = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]);
    const ligne = { id: 'p1', report_gz: rapport, is_compressed: 1 };

    const relu = decoderLigne(JSON.parse(JSON.stringify(encoderLigne(ligne))));

    expect(Buffer.isBuffer(relu.report_gz)).toBe(true);
    expect(relu.report_gz).toEqual(rapport);
    expect(relu.is_compressed).toBe(1);
  });

  it('REND une colonne JSON à sa forme textuelle', () => {
    // `mysql2` désérialise les colonnes JSON : `metadata` revient en objet, et
    // un objet passé en paramètre est échappé en paires « clé = valeur ». La
    // contrainte `json_valid` de MariaDB refuse alors l'insertion — constaté
    // contre une vraie base, pas déduit.
    const relu = decoderLigne({ metadata: { cms: 'wordpress' }, tags: ['a', 'b'] });

    expect(relu.metadata).toBe('{"cms":"wordpress"}');
    expect(relu.tags).toBe('["a","b"]');
  });

  it('laisse les valeurs non binaires intactes', () => {
    const ligne = {
      id: 'p1',
      url: 'https://exemple.fr/',
      global_score: '4.25',
      analyzed_at: '2026-01-01 10:00:00',
      report: null,
      check_summary: '{"seo":"ok"}',
    };

    // `null` n'est PAS un objet à sérialiser : le confondre écrirait « null »
    // dans une colonne nullable.
    expect(decoderLigne(JSON.parse(JSON.stringify(encoderLigne(ligne))))).toEqual(ligne);
  });

  it('ne prend PAS un objet quelconque pour un binaire', () => {
    // Le marqueur doit porter une CHAÎNE : un objet métier qui aurait par
    // hasard cette clé ne doit pas devenir un Buffer. Il repart en JSON, comme
    // toute colonne JSON.
    const relu = decoderLigne({ metadata: { $b64: 42 } });

    expect(Buffer.isBuffer(relu.metadata)).toBe(false);
    expect(relu.metadata).toBe('{"$b64":42}');
  });

  it('traverse un Buffer VIDE sans le perdre', () => {
    const relu = decoderLigne(JSON.parse(JSON.stringify(encoderLigne({ r: Buffer.alloc(0) }))));

    expect(Buffer.isBuffer(relu.r)).toBe(true);
    expect((relu.r as Buffer).length).toBe(0);
  });
});

describe('libelleCorbeille', () => {
  it('NOMME l’absence de gamme au lieu de la laisser vide', () => {
    // « exemple.fr| » laisserait croire à une gamme vide ; l'utilisateur relit
    // sa corbeille, il ne lit pas un index.
    expect(libelleCorbeille('site', 'exemple.fr', null)).toBe('exemple.fr (sans gamme)');
  });

  it('joint le domaine et la gamme pour un site', () => {
    expect(libelleCorbeille('site', 'exemple.fr', 'premium')).toBe('exemple.fr — premium');
  });

  it('n’attache AUCUNE gamme à un domaine entier', () => {
    // Plusieurs sites partagent un domaine, chacun avec sa gamme : en désigner
    // une reviendrait à en choisir une au hasard.
    expect(libelleCorbeille('domain', 'exemple.fr', 'premium')).toBe('exemple.fr');
  });

  it('traite une session comme son site', () => {
    expect(libelleCorbeille('session', 'exemple.fr', 'standard')).toBe('exemple.fr — standard');
  });
});
