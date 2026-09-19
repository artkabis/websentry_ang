import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { FaviconAnalyzer } from './favicon.analyzer.js';

const analyzer = new FaviconAnalyzer();
const settings = makeSettings();

function head(inner: string): string {
  return `<html><head>${inner}</head><body></body></html>`;
}

describe('FaviconAnalyzer', () => {
  it('valide une favicon et une icône iOS personnalisées', async () => {
    const result = await analyzer.analyze(
      makePage(
        head('<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/ios.png">'),
      ),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('ÉCHOUE quand la page n’a aucune icône', async () => {
    const result = await analyzer.analyze(makePage(head('<title>x</title>')), settings);

    expect(result.status).toBe('fail');
    expect(result.items[0]?.key).toBe('FAVICON.missing');
  });

  it('AVERTIT quand seule l’icône iOS est présente', async () => {
    const result = await analyzer.analyze(
      makePage(head('<link rel="apple-touch-icon" href="/ios.png">')),
      settings,
    );

    expect(result.status).toBe('warning');
    expect(result.items.some(item => item.key === 'FAVICON.missing')).toBe(true);
  });

  it('AVERTIT quand l’icône iOS manque', async () => {
    const result = await analyzer.analyze(
      makePage(head('<link rel="icon" href="/favicon.ico">')),
      settings,
    );

    expect(result.items.some(item => item.key === 'FAVICON.apple_touch_missing')).toBe(true);
  });

  it('reconnaît la favicon par défaut de l’éditeur', async () => {
    const result = await analyzer.analyze(
      makePage(
        head(
          '<link rel="icon" href="https://static.cdn-website.com/d.ico"><link rel="apple-touch-icon" href="/ios.png">',
        ),
      ),
      settings,
    );

    expect(result.items.some(item => item.key === 'FAVICON.duda_default')).toBe(true);
    expect(result.status).toBe('warning');
  });

  it('reconnaît une URL PROTOCOLE-RELATIVE vers le CDN de l’éditeur', async () => {
    // `new URL('//host/x')` seul lève : la v1 avalait l'exception et déclarait
    // donc « personnalisée » une favicon par défaut, forme que Duda émet
    // pourtant couramment.
    const result = await analyzer.analyze(
      makePage(
        head(
          '<link rel="icon" href="//static.cdn-website.com/d.ico"><link rel="apple-touch-icon" href="/ios.png">',
        ),
      ),
      settings,
    );

    expect(result.items.some(item => item.key === 'FAVICON.duda_default')).toBe(true);
  });

  it('ne se laisse pas égarer par un href illisible', async () => {
    const result = await analyzer.analyze(
      makePage(
        head('<link rel="icon" href="::pas-une-url"><link rel="apple-touch-icon" href="/ios.png">'),
      ),
      settings,
    );

    expect(result.items.some(item => item.key === 'FAVICON.present')).toBe(true);
  });

  it('compte les tailles déclarées', async () => {
    const result = await analyzer.analyze(
      makePage(
        head(
          '<link rel="icon" sizes="32x32" href="/a.png"><link rel="apple-touch-icon" sizes="180x180" href="/b.png">',
        ),
      ),
      settings,
    );

    expect(result.items.find(item => item.key === 'FAVICON.sizes')?.value).toBe(2);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage(head('')),
      makeSettings({ disabledChecks: ['FAVICON'] }),
    );

    expect(result.status).toBe('na');
  });
});
