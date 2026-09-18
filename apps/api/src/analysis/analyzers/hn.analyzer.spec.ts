import { describe, expect, it } from 'vitest';
import { HnAnalyzer, containsWord } from './hn.analyzer.js';
import { makePage, makeSettings } from '../testing/page.factory.js';

const analyzer = new HnAnalyzer();

describe('HnAnalyzer', () => {
  it('valide une hiérarchie correcte', async () => {
    const page = makePage('<h1>Titre</h1><h2>Section A</h2><h3>Détail</h3><h2>Section B</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.status).toBe('pass');
  });

  it('sanctionne une page sans aucun titre', async () => {
    const result = await analyzer.analyze(makePage('<p>texte</p>'), makeSettings());
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('Aucun titre');
  });

  it('sanctionne un H1 absent', async () => {
    const result = await analyzer.analyze(makePage('<h2>A</h2><h2>B</h2>'), makeSettings());
    expect(result.items.some(item => item.key === 'HN.h1_missing')).toBe(true);
    expect(result.status).toBe('fail');
  });

  it('sanctionne un H1 dupliqué', async () => {
    const page = makePage('<h1>A</h1><h1>B</h1><h2>C</h2><h2>D</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'HN.h1_duplicate')).toBe(true);
  });

  it('avertit quand le premier titre n’est pas le H1', async () => {
    const page = makePage('<h2>Avant</h2><h1>Titre</h1><h2>Après</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'HN.first_not_h1')).toBe(true);
  });

  it('avertit sur des H2 insuffisants', async () => {
    const result = await analyzer.analyze(makePage('<h1>A</h1><h2>B</h2>'), makeSettings());
    expect(result.items.some(item => item.key === 'HN.h2_insufficient')).toBe(true);
  });

  it('SIGNALE un saut de niveau', async () => {
    // Un saut H2 → H4 casse la table des matières que produisent les lecteurs
    // d'écran : l'utilisateur croit avoir manqué une section.
    const page = makePage('<h1>A</h1><h2>B</h2><h4>D</h4><h2>C</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'HN.hierarchy_break')).toBe(true);
  });

  it('accepte une REMONTÉE de niveau', async () => {
    // H3 → H2 n'est pas un saut : on ferme une sous-section, c'est normal.
    const page = makePage('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'HN.hierarchy_ok')).toBe(true);
  });

  it('signale les mots courants SANS entamer la note', async () => {
    const page = makePage('<h1>Le pain</h1><h2>Section A</h2><h2>Section B</h2>');
    const result = await analyzer.analyze(page, makeSettings());
    const common = result.items.filter(item => item.key === 'HN.common_words');
    expect(common.length).toBeGreaterThan(0);
    expect(common[0]?.status).toBe('info');
    expect(result.status).toBe('pass');
  });

  it('attache un ancrage au titre fautif', async () => {
    const page = makePage('<h1>Premier titre</h1><h1>Second titre</h1>');
    const result = await analyzer.analyze(page, makeSettings());
    const duplicate = result.items.find(item => item.key === 'HN.h1_duplicate');
    expect(duplicate?.locator?.text).toContain('Premier');
    expect(duplicate?.source).toContain('<h1>');
  });

  it('se retire quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<p>x</p>'),
      makeSettings({ disabledChecks: ['HN_STRUCTURE'] }),
    );
    expect(result.status).toBe('na');
  });
});

describe('containsWord', () => {
  it('reconnaît le mot entier, à toutes les positions', () => {
    expect(containsWord('de', 'de')).toBe(true);
    expect(containsWord('de la maison', 'de')).toBe(true);
    expect(containsWord('la maison de', 'de')).toBe(true);
    expect(containsWord('la maison de pierre', 'de')).toBe(true);
  });

  it('NE reconnaît PAS un mot inclus dans un autre', () => {
    // Une simple inclusion signalerait « de » dans « demain » : le critère
    // deviendrait bruyant au point d'être ignoré.
    expect(containsWord('demain', 'de')).toBe(false);
    expect(containsWord('grande maison', 'de')).toBe(false);
  });

  it('ignore la casse', () => {
    expect(containsWord('DE la maison', 'de')).toBe(true);
  });
});
