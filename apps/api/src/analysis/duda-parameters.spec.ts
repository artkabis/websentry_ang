import { describe, expect, it } from 'vitest';
import { isEcommerceActive, parseDudaParameters } from './duda-parameters.js';

/** Fragment de `window.Parameters` tel que Duda l'écrit dans la page. */
function parameters(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join(',\n');
  return `<script>window.Parameters = window.Parameters || {\n${body}\n};</script>`;
}

/** Catalogue base64 non vide — une vraie boutique. */
const STORE_PAGES = Buffer.from(JSON.stringify({ '/boutique': 'x' })).toString('base64');

const ACTIVE_STORE = {
  StorePageAlias: "'boutique'",
  StorePath: "'/boutique'",
  StoreId: "'store-1'",
  StoreBaseUrl: "'https://exemple.fr/boutique'",
  StorePagesUrls: `'${STORE_PAGES}'`,
};

describe('parseDudaParameters', () => {
  it('rend null sur une page qui n’est pas un site Duda', () => {
    // Le cas MAJORITAIRE : ce n'est pas une anomalie, et rien ne doit s'en
    // plaindre dans le rapport.
    expect(parseDudaParameters('<html><body>Site classique</body></html>')).toBeNull();
  });

  it('extrait les champs d’identité du site', () => {
    const params = parseDudaParameters(
      parameters({
        HomeUrl: "'https://exemple.fr'",
        AccountUUID: "'acc-1'",
        SiteAlias: "'mon-site'",
        planID: "'PREMIUM'",
        IsSiteMultilingual: 'true',
        StoreVersion: '2',
      }),
    );

    expect(params).toMatchObject({
      homeUrl: 'https://exemple.fr',
      accountUUID: 'acc-1',
      siteAlias: 'mon-site',
      planID: 'PREMIUM',
      isMultilingual: true,
      storeVersion: 2,
    });
  });

  it('décode un champ encodé en base64', () => {
    const encoded = Buffer.from('Website').toString('base64');
    const params = parseDudaParameters(parameters({ SiteType: `atob('${encoded}')` }));

    expect(params?.siteType).toBe('Website');
  });

  it('découpe l’ExternalUid en gamme et EPJ', () => {
    const params = parseDudaParameters(parameters({ ExternalUid: "'PREMIUM|EPJ123|EPJ123|||'" }));

    expect(params?.gamme).toBe('PREMIUM');
    expect(params?.epj).toBe('EPJ123');
  });

  it('rend null pour un ExternalUid aux champs vides', () => {
    const params = parseDudaParameters(parameters({ ExternalUid: "'||'" }));

    expect(params?.gamme).toBeNull();
    expect(params?.epj).toBeNull();
  });

  it('distingue un booléen absent d’un booléen faux', () => {
    // `null` veut dire « Duda ne l'a pas écrit », ce qui n'est pas « non ».
    const absent = parseDudaParameters(parameters({ HomeUrl: "'x'" }));
    const explicit = parseDudaParameters(parameters({ IsSiteMultilingual: 'false' }));

    expect(absent?.isMultilingual).toBeNull();
    expect(explicit?.isMultilingual).toBe(false);
  });
});

describe('isEcommerceActive', () => {
  it('reconnaît une boutique réellement en service', () => {
    const params = parseDudaParameters(parameters(ACTIVE_STORE));

    expect(params && isEcommerceActive(params)).toBe(true);
  });

  it('REFUSE les champs à la chaîne « null » que Duda écrit sans boutique', () => {
    // Duda renseigne ces champs sur TOUT site : s'y fier annoncerait une
    // boutique sur chaque vitrine.
    const params = parseDudaParameters(parameters({ ...ACTIVE_STORE, StoreId: "'null'" }));

    expect(params && isEcommerceActive(params)).toBe(false);
  });

  it('REFUSE un catalogue vide', () => {
    // `e30=` est le base64 de `{}` : une boutique déclarée mais sans page.
    const params = parseDudaParameters(parameters({ ...ACTIVE_STORE, StorePagesUrls: "'e30='" }));

    expect(params && isEcommerceActive(params)).toBe(false);
  });

  it('REFUSE un catalogue illisible plutôt que de deviner', () => {
    const params = parseDudaParameters(
      parameters({ ...ACTIVE_STORE, StorePagesUrls: "'pas-du-base64-json'" }),
    );

    expect(params && isEcommerceActive(params)).toBe(false);
  });

  it('REFUSE un catalogue base64 valide mais qui n’est pas un objet', () => {
    const scalar = Buffer.from('"texte"').toString('base64');
    const params = parseDudaParameters(
      parameters({ ...ACTIVE_STORE, StorePagesUrls: `'${scalar}'` }),
    );

    expect(params && isEcommerceActive(params)).toBe(false);
  });
});
