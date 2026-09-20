import { describe, expect, it } from 'vitest';
import { applyPageRules, ruleMatches } from './page-rules.js';
import { makeSettings } from './testing/page.factory.js';

describe('ruleMatches', () => {
  it('« / » ne désigne QUE la racine', () => {
    expect(ruleMatches(['/'], '/')).toBe(true);
    expect(ruleMatches(['/'], '/contact')).toBe(false);
  });

  it('cherche le motif dans les SEGMENTS, pas dans le chemin entier', () => {
    expect(ruleMatches(['contact'], '/nous-contacter')).toBe(true);
    expect(ruleMatches(['contact'], '/a/contact/b')).toBe(true);
  });

  it('ignore la casse', () => {
    expect(ruleMatches(['CONTACT'], '/Contact')).toBe(true);
  });

  it('ignore un motif vide', () => {
    expect(ruleMatches([''], '/contact')).toBe(false);
  });

  it('ne correspond à rien sans motif', () => {
    expect(ruleMatches([], '/contact')).toBe(false);
  });
});

describe('applyPageRules', () => {
  it('rend l’objet D’ORIGINE quand aucune règle n’existe', () => {
    // Le cas courant : on ne veut pas payer une copie par page d'un lot.
    const settings = makeSettings();
    expect(applyPageRules('https://exemple.fr/', settings)).toBe(settings);
  });

  it('rend l’objet d’origine quand aucune règle ne correspond', () => {
    const settings = makeSettings({ pageRules: [{ label: 'Contact', patterns: ['contact'] }] });
    expect(applyPageRules('https://exemple.fr/accueil', settings)).toBe(settings);
  });

  it('applique les critères désactivés', () => {
    const settings = makeSettings({
      pageRules: [{ label: 'Contact', patterns: ['contact'], disabledChecks: ['CONTENT_LENGTH'] }],
    });
    const effective = applyPageRules('https://exemple.fr/contact', settings);
    expect(effective.disabledChecks).toContain('CONTENT_LENGTH');
  });

  it('ACCUMULE les désactivations de plusieurs règles applicables', () => {
    const settings = makeSettings({
      pageRules: [
        { label: 'A', patterns: ['contact'], disabledChecks: ['CONTENT_LENGTH'] },
        { label: 'B', patterns: ['contact'], disabledChecks: ['CANONICAL'] },
      ],
    });
    const effective = applyPageRules('https://exemple.fr/contact', settings);
    expect(effective.disabledChecks).toEqual(
      expect.arrayContaining(['CONTENT_LENGTH', 'CANONICAL']),
    );
  });

  it('surcharge les seuils de contenu', () => {
    const settings = makeSettings({
      pageRules: [
        { label: 'Contact', patterns: ['contact'], settings: { content: { minWords: 10 } } },
      ],
    });
    const effective = applyPageRules('https://exemple.fr/contact', settings);
    expect(effective.content.minWords).toBe(10);
    // Les autres seuils de contenu sont CONSERVÉS, pas écrasés.
    expect(effective.content.warningWords).toBe(settings.content.warningWords);
  });

  it('loge les surcharges Hn dans un champ DISTINCT des réglages persistés', () => {
    // `hnByTag` naît d'une règle et ne vaut que le temps d'une analyse : le
    // mettre dans les réglages l'exposerait à l'écriture.
    const settings = makeSettings({
      pageRules: [{ label: 'Contact', patterns: ['contact'], settings: { h1: { maxLength: 40 } } }],
    });
    const effective = applyPageRules('https://exemple.fr/contact', settings);
    expect(effective.hnByTag?.h1?.maxLength).toBe(40);
    expect(settings).not.toHaveProperty('hnByTag');
  });

  it('ne MODIFIE PAS les réglages d’origine', () => {
    const settings = makeSettings({
      pageRules: [{ label: 'Contact', patterns: ['contact'], disabledChecks: ['CONTENT_LENGTH'] }],
    });
    const before = settings.disabledChecks;
    applyPageRules('https://exemple.fr/contact', settings);
    expect(settings.disabledChecks).toBe(before);
  });

  it('applique le profil tel quel sur une URL illisible', () => {
    const settings = makeSettings({ pageRules: [{ label: 'A', patterns: ['contact'] }] });
    expect(applyPageRules('pas une url', settings)).toBe(settings);
  });
});
