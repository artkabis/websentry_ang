import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { StructuredDataAnalyzer } from './structured-data.analyzer.js';

const analyzer = new StructuredDataAnalyzer();
const settings = makeSettings();

function jsonLd(data: unknown): ReturnType<typeof makePage> {
  return makePage(`<script type="application/ld+json">${JSON.stringify(data)}</script>`);
}

const ENTITY = {
  '@type': 'LocalBusiness',
  name: 'Boulangerie',
  telephone: '+33123456789',
  address: { '@type': 'PostalAddress', streetAddress: '1 rue du Pain' },
};

describe('StructuredDataAnalyzer', () => {
  it('AVERTIT quand la page n’a aucune donnée structurée', async () => {
    const result = await analyzer.analyze(makePage('<p>Rien</p>'), settings);

    expect(result.status).toBe('warning');
    expect(result.items[0]?.key).toBe('SD.no_json_ld');
  });

  it('valide une entité complète', async () => {
    const result = await analyzer.analyze(jsonLd(ENTITY), settings);

    expect(result.status).toBe('pass');
    expect(result.items.some(item => item.label === '@type : LocalBusiness')).toBe(true);
  });

  it('APLATIT un @graph — la forme la plus répandue', async () => {
    // Défaut de la v1 : le document entier y était compté comme un bloc unique
    // « sans @type ». Le rapport signalait un défaut sur un balisage correct et
    // ne voyait aucune des entités déclarées.
    const result = await analyzer.analyze(
      jsonLd({
        '@context': 'https://schema.org',
        '@graph': [ENTITY, { '@type': 'WebSite', name: 'Site' }],
      }),
      settings,
    );

    expect(result.items.some(item => item.key === 'SD.type_missing')).toBe(false);
    expect(result.items.filter(item => item.key === 'SD.type_block')).toHaveLength(2);
    expect(result.status).toBe('pass');
  });

  it('aplatit aussi un tableau de blocs', async () => {
    const result = await analyzer.analyze(jsonLd([ENTITY, ENTITY]), settings);

    expect(result.items.find(item => item.key === 'SD.json_ld_count')?.label).toContain('2');
  });

  it('ÉCHOUE sur un JSON-LD syntaxiquement invalide', async () => {
    const result = await analyzer.analyze(
      makePage('<script type="application/ld+json">{ pas du json }</script>'),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'SD.json_invalid')).toBe(true);
  });

  it('AVERTIT sur un bloc sans @type', async () => {
    const result = await analyzer.analyze(jsonLd({ name: 'Sans type' }), settings);

    expect(result.items.some(item => item.key === 'SD.type_missing')).toBe(true);
  });

  it('traite un @type vide comme une absence de type', async () => {
    const result = await analyzer.analyze(jsonLd({ '@type': '   ', name: 'x' }), settings);

    expect(result.items.some(item => item.key === 'SD.type_missing')).toBe(true);
  });

  it('réclame nom, contact et adresse à une ENTITÉ', async () => {
    const result = await analyzer.analyze(jsonLd({ '@type': 'LocalBusiness' }), settings);

    const keys = result.items.map(item => item.key);
    expect(keys).toContain('SD.lb_name_missing');
    expect(keys).toContain('SD.lb_contact_missing');
    expect(keys).toContain('SD.lb_address_missing');
  });

  it('NE RÉCLAME RIEN à un type structurel', async () => {
    // Un fil d'Ariane n'a ni téléphone ni adresse : le lui demander produirait
    // trois avertissements sur un balisage parfaitement valide.
    const result = await analyzer.analyze(
      jsonLd({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem' }] }),
      settings,
    );

    expect(result.items.some(item => item.key === 'SD.lb_name_missing')).toBe(false);
    expect(result.status).toBe('pass');
  });

  it('accepte un sous-type de LocalBusiness qui ne porte pas le mot', async () => {
    // `Notary`, `Dentist`, `Restaurant` sont des entités locales : les exclure
    // par motif de nom les raterait toutes.
    const result = await analyzer.analyze(jsonLd({ '@type': 'Notary' }), settings);

    expect(result.items.some(item => item.key === 'SD.lb_name_missing')).toBe(true);
  });

  it('AVERTIT sur un BreadcrumbList vide', async () => {
    const result = await analyzer.analyze(
      jsonLd({ '@type': 'BreadcrumbList', itemListElement: [] }),
      settings,
    );

    expect(result.items.some(item => item.key === 'SD.breadcrumb_empty')).toBe(true);
  });

  it('compte les blocs Microdata', async () => {
    const result = await analyzer.analyze(
      makePage('<div itemscope itemtype="https://schema.org/Person"></div>'),
      settings,
    );

    expect(result.items.some(item => item.key === 'SD.microdata')).toBe(true);
  });

  describe('règle des cinq images', () => {
    const withImages = makeSettings({ structuredData: { requireFiveImages: true } });
    const five = ['a', 'b', 'c', 'd', 'e'].map(n => `https://exemple.fr/${n}.jpg`);

    it('valide cinq images distinctes', async () => {
      const result = await analyzer.analyze(jsonLd({ ...ENTITY, image: five }), withImages);

      expect(result.items.find(item => item.key === 'SD.lb_five_images')?.status).toBe('pass');
    });

    it('ÉCHOUE en dessous de cinq', async () => {
      const result = await analyzer.analyze(
        jsonLd({ ...ENTITY, image: five.slice(0, 3) }),
        withImages,
      );

      expect(result.items.find(item => item.key === 'SD.lb_five_images')?.status).toBe('fail');
    });

    it('NE COMPTE PAS deux fois la même image', async () => {
      // Cinq fois la même image satisfait la lettre de la règle sans en servir
      // l'intention.
      const result = await analyzer.analyze(
        jsonLd({ ...ENTITY, image: [...five.slice(0, 4), five[0]] }),
        withImages,
      );

      const item = result.items.find(entry => entry.key === 'SD.lb_five_images');
      expect(item?.status).toBe('fail');
      expect(item?.detail).toContain('Doublons');
    });

    it('AVERTIT quand cinq images uniques coexistent avec des doublons', async () => {
      const result = await analyzer.analyze(
        jsonLd({ ...ENTITY, image: [...five, five[0]] }),
        withImages,
      );

      expect(result.items.find(item => item.key === 'SD.lb_five_images')?.status).toBe('warning');
    });

    it('accepte des ImageObject en plus des URL simples', async () => {
      const mixed = [
        ...five.slice(0, 3),
        { '@type': 'ImageObject', url: 'https://exemple.fr/d.jpg' },
        { '@type': 'ImageObject', contentUrl: 'https://exemple.fr/e.jpg' },
      ];
      const result = await analyzer.analyze(jsonLd({ ...ENTITY, image: mixed }), withImages);

      expect(result.items.find(item => item.key === 'SD.lb_five_images')?.status).toBe('pass');
    });

    it('ne s’applique PAS aux types structurels', async () => {
      const result = await analyzer.analyze(jsonLd({ '@type': 'WebSite' }), withImages);

      expect(result.items.some(item => item.key === 'SD.lb_five_images')).toBe(false);
    });
  });

  describe('activation', () => {
    it('reste actif quand seul le critère PARENT est listé', async () => {
      // Le registre le déclare fusionné dans MENTIONS_LEGALES_DATA : un profil
      // qui ne liste que le parent le désactiverait sans le dire, et toute la
      // détection JSON-LD disparaîtrait.
      const result = await analyzer.analyze(
        jsonLd(ENTITY),
        makeSettings({ enabledChecks: ['MENTIONS_LEGALES_DATA'] }),
      );

      expect(result.status).toBe('pass');
    });

    it('se tait quand aucun des deux n’est listé', async () => {
      const result = await analyzer.analyze(
        jsonLd(ENTITY),
        makeSettings({ enabledChecks: ['METAS'] }),
      );

      expect(result.status).toBe('na');
    });

    it('obéit à une désactivation explicite', async () => {
      const result = await analyzer.analyze(
        jsonLd(ENTITY),
        makeSettings({ disabledChecks: ['STRUCTURED_DATA'] }),
      );

      expect(result.status).toBe('na');
    });
  });
});
