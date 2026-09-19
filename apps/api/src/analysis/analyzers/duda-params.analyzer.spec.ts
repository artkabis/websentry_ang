import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { DudaParamsAnalyzer } from './duda-params.analyzer.js';

const analyzer = new DudaParamsAnalyzer();

function dudaPage(fields: Record<string, string>) {
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join(',\n');
  return makePage(`<script>window.Parameters = {\n${body}\n};</script>`);
}

describe('DudaParamsAnalyzer', () => {
  it('reste NEUTRE sur une page non Duda', () => {
    return analyzer.analyze(makePage('<p>Site classique</p>')).then(result => {
      expect(result.status).toBe('na');
      expect(result.items).toHaveLength(0);
    });
  });

  it('n’entre JAMAIS dans le score, même sur un site Duda', async () => {
    // `na` et non `pass` : le critère constate. Le noter ferait monter le score
    // global d'un site au seul motif qu'il est hébergé chez Duda.
    const result = await analyzer.analyze(dudaPage({ HomeUrl: "'https://exemple.fr'" }));

    expect(result.status).toBe('na');
  });

  it('reste actif sous un profil qui ne le liste pas', async () => {
    // `DUDA_PARAMS` n'appartient à aucun profil de gamme : le soumettre à
    // `enabledChecks` le ferait disparaître dès qu'une gamme est appliquée —
    // c'est-à-dire précisément quand on cherche à savoir laquelle.
    const result = await analyzer.analyze(
      dudaPage({ ExternalUid: "'PREMIUM|EPJ1|'" }),
      makeSettings({ enabledChecks: ['METAS'] }),
    );

    expect(result.items.some(item => item.value === 'PREMIUM')).toBe(true);
  });

  it('expose la gamme et l’EPJ', async () => {
    const result = await analyzer.analyze(dudaPage({ ExternalUid: "'PREMIUM|EPJ42|EPJ42|||'" }));

    expect(result.summary).toContain('PREMIUM');
    expect(result.summary).toContain('EPJ42');
  });

  it('annonce une boutique seulement quand elle est complète', async () => {
    const pages = Buffer.from(JSON.stringify({ '/boutique': 'x' })).toString('base64');
    const result = await analyzer.analyze(
      dudaPage({
        StorePageAlias: "'boutique'",
        StorePath: "'/boutique'",
        StoreId: "'s1'",
        StoreBaseUrl: "'https://exemple.fr/boutique'",
        StorePagesUrls: `'${pages}'`,
      }),
    );

    expect(result.items.some(item => item.label === 'E-commerce actif')).toBe(true);
  });

  it('n’annonce PAS de boutique sur les champs vides de Duda', async () => {
    const result = await analyzer.analyze(
      dudaPage({ StorePageAlias: "'null'", StoreId: "'null'", StorePagesUrls: "'e30='" }),
    );

    expect(result.items.some(item => item.label === 'E-commerce actif')).toBe(false);
  });

  it('n’affiche pas les champs que la page ne déclare pas', async () => {
    const result = await analyzer.analyze(dudaPage({ HomeUrl: "'https://exemple.fr'" }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.label).toBe('URL du site');
  });
});
