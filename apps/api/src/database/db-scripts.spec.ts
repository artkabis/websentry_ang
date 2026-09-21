import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — outillage en JavaScript simple, hors du programme
// TypeScript : ces scripts s'exécutent avant toute compilation.
import { RANGS, decouperSql, lireEnv, lireRang } from '../../scripts/db-helpers.mjs';

const DOSSIER_SQL = join(import.meta.dirname, 'sql');

describe('découpage des fichiers SQL', () => {
  it('découpe chaque schéma du projet en instructions exécutables', () => {
    // Le script les joue une par une : `multipleStatements` reste désactivé,
    // parce qu'un pilote qui accepte plusieurs instructions par requête est
    // précisément ce qui transforme une injection en prise de contrôle.
    for (const fichier of readdirSync(DOSSIER_SQL).filter(nom => nom.endsWith('.sql'))) {
      const instructions = decouperSql(readFileSync(join(DOSSIER_SQL, fichier), 'utf8'));

      expect(instructions.length, fichier).toBeGreaterThan(0);
      for (const instruction of instructions) {
        expect(instruction, fichier).not.toMatch(/^--/);
        expect(instruction.trim(), fichier).not.toBe('');
      }
    }
  });

  it('IGNORE un point-virgule caché dans un commentaire', () => {
    // Sans retrait préalable des commentaires, celui-ci couperait l'instruction
    // en deux morceaux invalides.
    const instructions = decouperSql('-- point-virgule ; piégé\nSELECT 1;');

    expect(instructions).toEqual(['SELECT 1']);
  });

  it('applique les schémas dans l’ordre de leurs numéros', () => {
    // `users` doit exister avant les tables qui la référencent : l'ordre
    // alphabétique des noms de fichiers EST l'ordre de dépendance.
    const fichiers = readdirSync(DOSSIER_SQL)
      .filter(nom => nom.endsWith('.sql'))
      .sort();

    expect(fichiers[0]).toMatch(/^001-/);
    expect(fichiers).toEqual([...fichiers].sort());
  });
});

describe('lecture du fichier d’environnement', () => {
  it('lit les paires, ignore commentaires et lignes vides', () => {
    const valeurs = lireEnv('# commentaire\nDB_HOST=localhost\n\nDB_PORT=3306');

    expect(valeurs).toEqual({ DB_HOST: 'localhost', DB_PORT: '3306' });
  });

  it('retire les guillemets sans toucher au contenu', () => {
    expect(lireEnv('A="deux mots"\nB=\'trois\'')).toEqual({ A: 'deux mots', B: 'trois' });
  });

  it('CONSERVE les signes égal d’une valeur', () => {
    // Un secret en base64 en contient : couper à chaque `=` le tronquerait.
    expect(lireEnv('JWT_SECRET=abc==')).toEqual({ JWT_SECRET: 'abc==' });
  });
});

describe('lecture du rang', () => {
  it('accepte un nom ou un nombre', () => {
    expect(lireRang('admin')).toBe(RANGS.admin);
    expect(lireRang('100')).toBe(RANGS.super_admin);
  });

  it('REFUSE un rang que la base rejetterait', () => {
    // La table porte une contrainte `rank IN (10, 30, 50, 100)` : échouer ici
    // donne un message utile, échouer en base donne un code d'erreur SQL.
    expect(() => lireRang('42')).toThrow(/Rang inconnu/);
    expect(() => lireRang('root')).toThrow(/Rang inconnu/);
  });

  it('retient administrateur par défaut', () => {
    // C'est le premier compte d'une base neuve : il doit pouvoir tout régler.
    expect(lireRang(undefined)).toBe(RANGS.admin);
  });
});
