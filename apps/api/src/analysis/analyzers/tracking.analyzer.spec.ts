import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { TrackingAnalyzer } from './tracking.analyzer.js';

const analyzer = new TrackingAnalyzer();
const settings = makeSettings();

describe('TrackingAnalyzer', () => {
  it('reconnaît un traceur et sa plateforme de consentement', async () => {
    const result = await analyzer.analyze(
      makePage(
        '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script src="https://static.axeptio.eu/sdk.js"></script>',
      ),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.key === 'TRACKING.cmp_ok')).toBe(true);
  });

  it('ÉCHOUE sur des traceurs sans consentement — c’est un manquement RGPD', async () => {
    const result = await analyzer.analyze(
      makePage('<script>fbq("init", "123");</script>'),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'TRACKING.no_cmp')).toBe(true);
  });

  it('NE LIT PAS le texte visible : un lien « RGPD » ne vaut pas consentement', async () => {
    // Défaut de la v1 : le motif était cherché dans le document ENTIER, si
    // bien qu'un pied de page mentionnant le RGPD suffisait à déclarer le site
    // conforme — l'inverse de la réalité, sur le point qui engage l'éditeur.
    const result = await analyzer.analyze(
      makePage(
        '<script>fbq("init","1");</script><footer><a href="/rgpd">Politique RGPD et consentement</a></footer>',
      ),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'TRACKING.no_cmp')).toBe(true);
  });

  it('reconnaît une bannière qui ne se signale que dans le DOM', async () => {
    // Certaines solutions sont injectées côté serveur sans script identifiable :
    // les rater ferait accuser à tort un site pourtant conforme.
    const result = await analyzer.analyze(
      makePage('<script>_paq.push(["trackPageView"]);</script><div id="tarteaucitron"></div>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'TRACKING.cmp_ok')).toBe(true);
    expect(result.status).toBe('pass');
  });

  it('AVERTIT quand aucun outil de mesure n’est présent', async () => {
    const result = await analyzer.analyze(makePage('<p>Site sans mesure</p>'), settings);

    expect(result.status).toBe('warning');
    expect(result.items[0]?.key).toBe('TRACKING.none');
  });

  it('ne réclame PAS de consentement à une page sans traceur', async () => {
    // Sans traceur, il n'y a rien à consentir : exiger un bandeau ferait
    // échouer une page irréprochable.
    const result = await analyzer.analyze(makePage('<p>Rien</p>'), settings);

    expect(result.items.some(item => item.key === 'TRACKING.no_cmp')).toBe(false);
    expect(result.status).toBe('warning');
  });

  it('ne compte pas deux fois le même outil', async () => {
    const result = await analyzer.analyze(
      makePage(
        '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script>gtag("config","G-1");</script><div id="axeptio_overlay"></div>',
      ),
      settings,
    );

    const detected = result.items.filter(item => item.key === 'TRACKING.tool_detected');
    expect(detected).toHaveLength(1);
  });

  it('lit aussi les scripts en ligne', async () => {
    const result = await analyzer.analyze(
      makePage('<script>window.hjid = 42;</script><div id="didomi-host"></div>'),
      settings,
    );

    expect(
      result.items.some(item => typeof item.label === 'string' && item.label.includes('Hotjar')),
    ).toBe(true);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<p>x</p>'),
      makeSettings({ disabledChecks: ['TRACKING'] }),
    );

    expect(result.status).toBe('na');
  });
});
