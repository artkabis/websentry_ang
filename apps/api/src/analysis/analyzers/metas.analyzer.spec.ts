import { describe, expect, it } from 'vitest';
import { MetasAnalyzer, isPreviewUrl } from './metas.analyzer.js';
import { makePage, makeSettings } from '../testing/page.factory.js';

const analyzer = new MetasAnalyzer();

/** Titre et description valides au regard des bornes par défaut (50–65 / 140–156). */
const GOOD_TITLE = 'Boulangerie artisanale à Lyon — pains au levain nature';
const GOOD_DESC =
  'Notre boulangerie artisanale lyonnaise propose chaque matin des pains au levain naturel, ' +
  'des viennoiseries et des pâtisseries préparées sur place.';

function head(inner: string) {
  return makePage(`<html><head>${inner}</head><body></body></html>`);
}

describe('MetasAnalyzer', () => {
  it('valide des balises conformes', async () => {
    const result = await analyzer.analyze(
      head(`<title>${GOOD_TITLE}</title><meta name="description" content="${GOOD_DESC}">`),
      makeSettings(),
    );
    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('SANCTIONNE un title absent', async () => {
    const result = await analyzer.analyze(head(''), makeSettings());
    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'METAS.title_missing')).toBe(true);
  });

  it('avertit sur un title trop court', async () => {
    const result = await analyzer.analyze(head('<title>Accueil</title>'), makeSettings());
    expect(result.items.some(item => item.key === 'METAS.title_short')).toBe(true);
  });

  it('avertit sur un title trop long', async () => {
    const long = 'x'.repeat(200);
    const result = await analyzer.analyze(head(`<title>${long}</title>`), makeSettings());
    expect(result.items.some(item => item.key === 'METAS.title_long')).toBe(true);
  });

  it('sanctionne une description absente', async () => {
    const result = await analyzer.analyze(head(`<title>${GOOD_TITLE}</title>`), makeSettings());
    expect(result.items.some(item => item.key === 'METAS.desc_missing')).toBe(true);
  });

  it('accepte la graphie « Description » en majuscule', async () => {
    // `name` n'est pas sensible à la casse en HTML, alors que le sélecteur CSS
    // l'est : ne chercher qu'une graphie produirait un faux « absente ».
    const result = await analyzer.analyze(
      head(`<title>${GOOD_TITLE}</title><meta name="Description" content="${GOOD_DESC}">`),
      makeSettings(),
    );
    expect(result.items.some(item => item.key === 'METAS.desc_ok')).toBe(true);
  });

  it('honore les bornes du profil', async () => {
    const settings = makeSettings({
      meta: { title: { min: 1, max: 5 }, description: { min: 1, max: 5 } },
    });
    const result = await analyzer.analyze(head('<title>Accueil</title>'), settings);
    expect(result.items.some(item => item.key === 'METAS.title_long')).toBe(true);
  });

  it('SANCTIONNE un noindex sur une page publique', async () => {
    const result = await analyzer.analyze(
      head(
        `<title>${GOOD_TITLE}</title><meta name="description" content="${GOOD_DESC}"><meta name="robots" content="noindex">`,
      ),
      makeSettings(),
    );
    expect(result.items.some(item => item.key === 'METAS.noindex')).toBe(true);
    expect(result.status).toBe('fail');
  });

  it('TOLÈRE un noindex sur une URL de prévisualisation', async () => {
    // Le signaler en échec remplirait de rouge le rapport d'un site en cours de
    // construction, et apprendrait à l'équipe à ignorer ce critère.
    const page = makePage(
      `<html><head><title>${GOOD_TITLE}</title><meta name="description" content="${GOOD_DESC}"><meta name="robots" content="noindex"></head><body></body></html>`,
      { url: 'https://exemple.fr/?preview=1' },
    );
    const result = await analyzer.analyze(page, makeSettings());
    expect(result.items.some(item => item.key === 'METAS.noindex_preview')).toBe(true);
    expect(result.status).toBe('pass');
  });

  it('se retire quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(head(''), makeSettings({ disabledChecks: ['METAS'] }));
    expect(result.status).toBe('na');
    // « Non applicable » n'est pas un échec : le noter zéro ferait chuter la
    // moyenne d'un site simplement parce qu'un critère est désactivé pour lui.
    expect(result.globalScore).toBe(5);
  });
});

describe('isPreviewUrl', () => {
  it.each([
    'https://exemple.fr/?preview=1',
    'https://site.responsivesiteeditor.com/page',
    'https://dudaadmin.com/site/abc',
  ])('reconnaît %s', url => {
    expect(isPreviewUrl(url)).toBe(true);
  });

  it('ne reconnaît pas une URL publique', () => {
    expect(isPreviewUrl('https://exemple.fr/accueil')).toBe(false);
  });

  it('rend false sur une URL illisible', () => {
    expect(isPreviewUrl('pas une url')).toBe(false);
  });
});
