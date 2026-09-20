import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { HnLengthAnalyzer } from './hn-length.analyzer.js';

const analyzer = new HnLengthAnalyzer();
/** Bornes resserrées : les titres du test restent lisibles. */
const settings = makeSettings({ hn: { minLength: 10, maxLength: 20, excludedWords: [] } });

describe('HnLengthAnalyzer', () => {
  it('valide un titre dans la fourchette', async () => {
    const result = await analyzer.analyze(makePage('<h1>Titre parfait ok</h1>'), settings);

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('ÉCHOUE sur un titre trop court', async () => {
    const result = await analyzer.analyze(makePage('<h1>Court</h1>'), settings);

    expect(result.status).toBe('fail');
    expect(result.items[0]?.key).toBe('HN_LENGTH.too_short');
  });

  it('AVERTIT sur un titre trop long, sans échouer', async () => {
    // Un titre trop long reste lu par les moteurs, seulement tronqué : la
    // gravité n'est pas celle d'un titre indigent.
    const result = await analyzer.analyze(
      makePage('<h2>Un titre nettement trop long pour la borne fixée</h2>'),
      settings,
    );

    expect(result.status).toBe('warning');
    expect(result.items[0]?.key).toBe('HN_LENGTH.too_long');
  });

  it('applique les bornes PAR BALISE quand une règle de page en fournit', async () => {
    // `hnByTag` vient d'une règle de page : une page de contact peut tolérer
    // un H1 plus court que le reste du site.
    const result = await analyzer.analyze(
      makePage('<h1>Contact</h1>'),
      makeSettings({
        hn: { minLength: 50, maxLength: 90, excludedWords: [] },
        hnByTag: { h1: { minLength: 5, maxLength: 30 } },
      }),
    );

    expect(result.status).toBe('pass');
  });

  it('IGNORE un titre vide plutôt que de le déclarer trop court', async () => {
    // Un H1 vide est un défaut de STRUCTURE : le compter ici afficherait
    // « trop court (0 car.) », ce qui désigne le mauvais problème.
    const result = await analyzer.analyze(makePage('<h1>   </h1>'), settings);

    expect(result.items[0]?.key).toBe('HN_LENGTH.no_h1_h2');
    expect(result.status).toBe('pass');
  });

  it('ne pénalise pas une page sans H1 ni H2', async () => {
    const result = await analyzer.analyze(makePage('<p>Texte</p>'), settings);

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('DÉGRADE le score à mesure que les titres fautifs s’accumulent', async () => {
    const one = await analyzer.analyze(makePage('<h1>Court</h1>'), settings);
    const three = await analyzer.analyze(
      makePage('<h1>Court</h1><h2>Bref</h2><h2>Petit</h2>'),
      settings,
    );

    expect(three.globalScore).toBeLessThan(one.globalScore);
  });

  it('ancre chaque titre fautif dans la page', async () => {
    const result = await analyzer.analyze(makePage('<h1>Court</h1>'), settings);

    expect(result.items[0]?.locator).toEqual({ text: 'Court' });
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<h1>Court</h1>'),
      makeSettings({ disabledChecks: ['HN_LENGTH'] }),
    );

    expect(result.status).toBe('na');
  });
});
