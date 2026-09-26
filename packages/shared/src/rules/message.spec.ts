import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IMPORTANCES_MESSAGE, sInterrompt } from './message.js';

describe('sInterrompt', () => {
  it('ne laisse QUE « critique » s’imposer à l’écran', () => {
    expect(sInterrompt('critique')).toBe(true);
    expect(sInterrompt('haute')).toBe(false);
    expect(sInterrompt('normale')).toBe(false);
  });
});

describe('IMPORTANCES_MESSAGE', () => {
  it('est le vocabulaire dont la règle a besoin, et rien de plus', () => {
    // Le schéma s'aligne sur cette liste : un niveau ajouté ici sans
    // comportement propre serait un niveau que rien ne distingue.
    expect([...IMPORTANCES_MESSAGE]).toEqual(['normale', 'haute', 'critique']);
  });

  it('NE DÉPEND PAS du validateur', () => {
    // Le cœur de la séparation : ce module doit pouvoir être chargé sans que
    // Zod le soit. Un import statique de Zod ici ramènerait 125 kio dans le
    // chargement initial du frontend. Le contrôle du noyau le vérifie de bout
    // en bout côté build ; ce test le dit tout de suite, ici.
    const source = readFileSync(join(process.cwd(), 'src/rules/message.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]zod['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/schemas\//);
  });
});
