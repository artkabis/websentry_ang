import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { MentionsLegalesDataAnalyzer } from './mentions-legales-data.analyzer.js';

const analyzer = new MentionsLegalesDataAnalyzer();
const settings = makeSettings();

const LEGAL_URL = 'https://exemple.fr/mentions-legales';

/** Champs obligatoires seuls — les optionnels restent vides. */
const MANDATORY_ONLY = {
  raisonsociale: 'Boulangerie Durand',
  juridique: 'SARL',
  capitalsocial: '10 000 €',
  adresse: '1 rue du Pain, Lyon',
  email: 'contact@exemple.fr',
  telephone: '04 72 00 00 00',
  rcs: 'RCS Lyon 123 456 789',
  siret: '123 456 789 00012',
  directeur: 'Jean Durand',
};

/**
 * Configuration intégralement renseignée.
 *
 * Un champ optionnel vide vaut un avertissement : une configuration
 * « complète » au sens du critère est donc celle où AUCUN champ ne manque.
 */
const COMPLETE = {
  ...MANDATORY_ONLY,
  tva: 'FR12345678900',
  reglespro: 'Aucune',
  titrepro: 'Artisan boulanger',
  etat: 'France',
  ordre: 'Chambre des métiers',
  specifique: 'Néant',
  champlibre: 'Néant',
  mediateur: 'Médiation de la consommation, 75001 Paris',
  mentionsobligatoires: 'Néant',
};

function widgetPage(config: Record<string, unknown>, url = LEGAL_URL) {
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64');
  return makePage(`<div data-widget-config="${encoded}"></div>`, { url, platform: 'duda' });
}

describe('MentionsLegalesDataAnalyzer', () => {
  describe('applicabilité', () => {
    it('se déclare NON APPLICABLE hors de l’éditeur', async () => {
      const result = await analyzer.analyze(
        makePage('<p>x</p>', { url: LEGAL_URL, platform: 'generic' }),
        settings,
      );

      expect(result.status).toBe('na');
    });

    it('se déclare NON APPLICABLE hors de la page de mentions légales', async () => {
      const result = await analyzer.analyze(
        widgetPage(COMPLETE, 'https://exemple.fr/contact'),
        settings,
      );

      expect(result.status).toBe('na');
    });

    it('reconnaît les variantes du chemin', async () => {
      const result = await analyzer.analyze(
        widgetPage(COMPLETE, 'https://exemple.fr/mentionslegales'),
        settings,
      );

      expect(result.status).toBe('pass');
    });
  });

  describe('configuration embarquée', () => {
    it('valide une configuration complète', async () => {
      const result = await analyzer.analyze(widgetPage(COMPLETE), settings);

      expect(result.status).toBe('pass');
      expect(result.items.some(item => item.key === 'ML_DATA.widget_found')).toBe(true);
    });

    it('ÉCHOUE sur un champ obligatoire vide', async () => {
      const result = await analyzer.analyze(widgetPage({ ...COMPLETE, directeur: '' }), settings);

      expect(result.status).toBe('fail');
      expect(result.items.find(item => item.key === 'ML_DATA.binding_directeur')?.status).toBe(
        'fail',
      );
    });

    it('se contente d’AVERTIR sur un champ optionnel vide', async () => {
      // Beaucoup d'activités n'ont ni ordre professionnel ni médiateur : les
      // compter en défaut ferait échouer un site parfaitement conforme.
      const result = await analyzer.analyze(widgetPage(MANDATORY_ONLY), settings);

      expect(result.items.find(item => item.key === 'ML_DATA.binding_tva')?.status).toBe('warning');
    });

    it('nettoie le balisage et les gabarits de l’éditeur', async () => {
      const result = await analyzer.analyze(
        widgetPage({ ...COMPLETE, adresse: '<p>1 rue du Pain[[placeholder]]</p>' }),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_adresse')?.value).toBe(
        '1 rue du Pain',
      );
    });

    it('accepte une configuration en JSON brut', async () => {
      const page = makePage(`<div data-widget-config='${JSON.stringify(COMPLETE)}'></div>`, {
        url: LEGAL_URL,
        platform: 'duda',
      });

      const result = await analyzer.analyze(page, settings);

      expect(result.status).toBe('pass');
    });

    it('IGNORE la configuration d’un autre widget', async () => {
      // Sans champ signature, ce n'est pas la configuration des mentions
      // légales : la prendre pour telle déclarerait tous les champs manquants.
      const other = Buffer.from(JSON.stringify({ couleur: 'bleu' })).toString('base64');
      const page = makePage(`<div data-widget-config="${other}"></div>`, {
        url: LEGAL_URL,
        platform: 'duda',
      });

      const result = await analyzer.analyze(page, settings);

      expect(result.items.some(item => item.key === 'ML_DATA.widget_missing')).toBe(true);
    });
  });

  describe('structure du RCS', () => {
    it('valide une mention conforme, recoupée avec le SIRET', async () => {
      const result = await analyzer.analyze(widgetPage(COMPLETE), settings);

      const rcs = result.items.find(item => item.key === 'ML_DATA.binding_rcs');
      expect(rcs?.status).toBe('pass');
      expect(rcs?.detail).toContain('cohérent');
    });

    it('accepte une mention sans le mot-clé RCS', async () => {
      // Le champ porte déjà le mot dans son intitulé : les valeurs réelles
      // l'omettent souvent.
      const result = await analyzer.analyze(
        widgetPage({ ...COMPLETE, rcs: 'Lyon B 123 456 789' }),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_rcs')?.status).toBe('pass');
    });

    it('AVERTIT quand le SIREN manque', async () => {
      const result = await analyzer.analyze(widgetPage({ ...COMPLETE, rcs: 'RCS Lyon' }), settings);

      const rcs = result.items.find(item => item.key === 'ML_DATA.binding_rcs');
      expect(rcs?.status).toBe('warning');
      expect(rcs?.detail).toContain('SIREN');
    });

    it('AVERTIT quand la ville de greffe manque', async () => {
      const result = await analyzer.analyze(
        widgetPage({ ...COMPLETE, rcs: 'RCS 123 456 789' }),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_rcs')?.detail).toContain(
        'ville',
      );
    });

    it('SIGNALE une incohérence entre RCS et SIRET', async () => {
      const result = await analyzer.analyze(
        widgetPage({ ...COMPLETE, rcs: 'RCS Lyon 987 654 321' }),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_rcs')?.detail).toContain(
        'ne correspond pas',
      );
    });
  });

  describe('liaisons CMS', () => {
    function bindingPage(
      bindings: Array<{ bindingName: string; value: string }>,
      fields: string,
      url = LEGAL_URL,
    ) {
      const encoded = Buffer.from(JSON.stringify(bindings)).toString('base64');
      return makePage(`<div data-binding="${encoded}"></div>${fields}`, {
        url,
        platform: 'duda',
      });
    }

    it('lit la valeur dans le champ lié', async () => {
      const result = await analyzer.analyze(
        bindingPage(
          [
            { bindingName: 'raisonsociale', value: 'site_text.zz_01 raison sociale' },
            { bindingName: 'directeur', value: 'site_text.zz_02 directeur' },
          ],
          '<span data-field="zz_01 raison sociale">Boulangerie Durand</span>',
        ),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_raisonsociale')?.value).toBe(
        'Boulangerie Durand',
      );
    });

    it('se rabat sur l’identifiant court', async () => {
      const result = await analyzer.analyze(
        bindingPage(
          [
            { bindingName: 'raisonsociale', value: 'site_text.zz_01 raison sociale' },
            { bindingName: 'directeur', value: 'site_text.zz_02' },
          ],
          '<span data-field="zz_01">Durand SARL</span>',
        ),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_raisonsociale')?.value).toBe(
        'Durand SARL',
      );
    });

    it('ne conclut RIEN quand la valeur est rendue côté client', async () => {
      const result = await analyzer.analyze(
        bindingPage(
          [
            { bindingName: 'raisonsociale', value: 'site_text.zz_01' },
            { bindingName: 'directeur', value: 'site_text.zz_02' },
          ],
          '',
        ),
        settings,
      );

      expect(result.items.find(item => item.key === 'ML_DATA.binding_raisonsociale')?.status).toBe(
        'info',
      );
    });

    it('ne se laisse pas casser par une clé HOSTILE', async () => {
      // La clé vient d'une configuration base64 contenue dans la page
      // analysée : la concaténer dans un sélecteur laisserait son auteur faire
      // tomber le critère entier.
      const result = await analyzer.analyze(
        bindingPage(
          [
            { bindingName: 'raisonsociale', value: 'site_text.x"], *' },
            { bindingName: 'directeur', value: 'site_text.zz_02' },
          ],
          '<span data-field="zz_02">Jean Durand</span>',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'ML_DATA.widget_found')).toBe(true);
    });
  });

  it('ÉCHOUE quand aucun widget n’est présent', async () => {
    const result = await analyzer.analyze(
      makePage('<p>Mentions légales</p>', { url: LEGAL_URL, platform: 'duda' }),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.items[0]?.key).toBe('ML_DATA.widget_missing');
  });

  it('distingue un widget présent mais non reconnu', async () => {
    const result = await analyzer.analyze(
      makePage('<div dmle_extension="custom_extension"></div>', {
        url: LEGAL_URL,
        platform: 'duda',
      }),
      settings,
    );

    expect(result.items[0]?.label).toContain('non reconnu');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      widgetPage(COMPLETE),
      makeSettings({ disabledChecks: ['MENTIONS_LEGALES_DATA'] }),
    );

    expect(result.status).toBe('na');
  });
});
