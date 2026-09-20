import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { DataBindingAnalyzer } from './data-binding.analyzer.js';

const analyzer = new DataBindingAnalyzer();
const settings = makeSettings();

/** Encode une liste de liaisons comme l'éditeur l'écrit dans l'attribut. */
function binding(entries: Array<{ bindingName: string; value: string }>): string {
  return Buffer.from(JSON.stringify(entries)).toString('base64');
}

function dudaPage(body: string) {
  return makePage(`<html><body>${body}</body></html>`, { platform: 'duda' });
}

describe('DataBindingAnalyzer', () => {
  it('se déclare NON APPLICABLE hors de l’éditeur', async () => {
    const result = await analyzer.analyze(makePage('<p>x</p>'), settings);

    expect(result.status).toBe('na');
  });

  it('ne descend JAMAIS jusqu’à l’échec', async () => {
    // Une liaison manquante se répare en un clic : elle ne casse pas la page,
    // et la noter comme un défaut bloquant fausserait le score global.
    const result = await analyzer.analyze(dudaPage('<p>Rien de connecté</p>'), settings);

    expect(result.status).toBe('warning');
    expect(result.globalScore).toBeGreaterThan(0);
  });

  describe('adresse du pied de page', () => {
    it('la reconnaît par le NOM de sa liaison', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="dmFooterContainer"><span data-inline-binding="site_text.adresse">1 rue du Pain</span></div>',
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.footer_address');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('1 rue du Pain');
    });

    it('la reconnaît par son CODE POSTAL quand la clé ne dit rien', async () => {
      // L'éditeur nomme rarement ses clés : un champ lié dont le texte porte
      // une adresse EST une adresse connectée.
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="dmFooterContainer"><span data-inline-binding="site_text.zz_01">12 rue du Pain, 69002 Lyon</span></div>',
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.footer_address');
      expect(item?.status).toBe('pass');
      expect(item?.detail).toContain('code postal');
    });

    it('ne prend PAS un capital social pour une adresse', async () => {
      // « au capital de 12500 euros » contient cinq chiffres : sans la
      // majuscule exigée derrière, il passerait pour un code postal.
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="dmFooterContainer"><span data-inline-binding="site_text.zz_01">SARL au capital de 12500 euros</span></div>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.footer_address')?.status).toBe(
        'warning',
      );
    });

    it('ne prend PAS un numéro de téléphone pour un code postal', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="dmFooterContainer"><span data-inline-binding="site_text.zz_01">0472000000 Lyon</span></div>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.footer_address')?.status).toBe(
        'warning',
      );
    });

    it('ne compte qu’UNE FOIS une liaison répétée sur des éléments imbriqués', async () => {
      // L'éditeur imbrique plusieurs éléments portant la même liaison : sans
      // déduplication, une seule adresse serait comptée trois fois.
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="dmFooterContainer"><div data-inline-binding="site_text.adresse"><span data-inline-binding="site_text.adresse">1 rue</span></div></div>',
        ),
        settings,
      );

      expect(
        result.items.find(entry => entry.key === 'DATA_BINDING.footer_address')?.label,
      ).toContain('1 adresse');
    });

    it('décode une clé encodée en base64', async () => {
      const encoded = Buffer.from('site_text.zz_ac adresse').toString('base64');
      const result = await analyzer.analyze(
        dudaPage(
          `<div class="dmFooterContainer"><span data-inline-binding-encoded="${encoded}">1 rue</span></div>`,
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.footer_address')?.status).toBe(
        'pass',
      );
    });

    it('AVERTIT quand le pied de page n’en contient aucune', async () => {
      const result = await analyzer.analyze(
        dudaPage('<div class="dmFooterContainer"><p>Tous droits réservés</p></div>'),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.footer_address')?.status).toBe(
        'warning',
      );
    });
  });

  describe('champs et liaisons', () => {
    it('compte les champs nommés et signale les vides', async () => {
      const result = await analyzer.analyze(
        dudaPage('<span data-field="phone">04 72 00</span><span data-field="email"></span>'),
        settings,
      );

      expect(
        result.items.find(item => item.key === 'DATA_BINDING.data_field_count')?.label,
      ).toContain('2');
      expect(
        result.items.find(item => item.key === 'DATA_BINDING.empty_data_field')?.detail,
      ).toContain('email');
    });

    it('distingue une liaison INACTIVE d’une liaison absente', async () => {
      const result = await analyzer.analyze(dudaPage('<span data-binding="0">x</span>'), settings);

      expect(result.items.some(item => item.key === 'DATA_BINDING.data_binding_empty')).toBe(true);
    });

    it('récapitule les liaisons par nom', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<span data-binding="${binding([{ bindingName: 'phone', value: 'x' }])}">a</span><span data-binding="${binding([{ bindingName: 'phone', value: 'y' }])}">b</span>`,
        ),
        settings,
      );

      expect(
        result.items.find(item => item.key === 'DATA_BINDING.data_binding_count')?.detail,
      ).toContain('phone ×2');
    });

    it('compte une liaison illisible comme ACTIVE sans prétendre la comprendre', async () => {
      const result = await analyzer.analyze(
        dudaPage('<span data-binding="pas-du-base64-json">x</span>'),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.data_binding_count');
      expect(item?.label).toContain('1 champ(s) connecté(s) actif(s) sur 1');
      expect(item?.detail).toContain('non décodé');
    });
  });

  describe('composants', () => {
    it('valide un logo lié à une image', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<div data-widget-type="logo"><img data-binding="${binding([{ bindingName: 'image', value: 'site_images.logo' }])}"></div>`,
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.logo_connected');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('site_images.logo');
    });

    it('AVERTIT sur un logo lié à autre chose qu’une image', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<div class="dmLogo"><img data-binding="${binding([{ bindingName: 'text', value: 'x' }])}"></div>`,
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.logo_connected')?.status).toBe(
        'warning',
      );
    });

    it('relève le numéro d’un lien d’appel connecté', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<a class="dmCall" data-binding="${binding([{ bindingName: 'phone', value: 'x' }])}" href="tel:0472000000"><span class="phoneNumHolder">04 72 00 00 00</span></a>`,
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.ctc_connected');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('04 72 00 00 00');
    });

    it('lit l’adresse affichée par une carte', async () => {
      // La v1 enchaînait deux recherches avec `||` : une sélection vide restant
      // un objet, donc toujours vraie, la seconde n'était jamais évaluée.
      const result = await analyzer.analyze(
        dudaPage(
          `<div class="map-wrapper"><div class="inlineMap" data-binding="${binding([{ bindingName: 'address', value: 'content_library.global' }])}"></div><span data-field="address">1 rue du Pain, Lyon</span></div>`,
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.map_connected');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('1 rue du Pain, Lyon');
    });

    it('préfère l’adresse déclarée par la carte', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<div class="inlineMap" addresstodisplay="2 place Bellecour, Lyon"><span data-field="address">Autre</span></div>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.map_connected')?.value).toBe(
        '2 place Bellecour, Lyon',
      );
    });

    it('reconstruit les horaires depuis la structure rendue', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<div data-element-type="open_hours" data-binding="${binding([{ bindingName: 'hours', value: 'x' }])}"><div class="open-hours-item"><dt day="0">Lundi</dt><dd><time>09:00</time><time>18:00</time></dd></div></div>`,
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.hours_connected');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('Lundi 09:00–18:00');
    });

    it('lit des horaires encodés à défaut de structure', async () => {
      const hours = Buffer.from(
        JSON.stringify([{ day: '1', open: '10:00', close: '19:00' }]),
      ).toString('base64');

      const result = await analyzer.analyze(
        dudaPage(`<div data-element-type="open_hours" hours_data="${hours}"></div>`),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.hours_connected')?.value).toBe(
        'Mar 10:00–19:00',
      );
    });

    it('nomme les réseaux sociaux par leur domaine', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          `<div class="dmSocialHub" data-binding="${binding([{ bindingName: 'social', value: 'x' }])}"><a href="https://www.facebook.com/page">F</a><a href="https://instagram.com/compte">I</a></div>`,
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.social_connected');
      expect(item?.status).toBe('pass');
      expect(item?.value).toBe('facebook.com, instagram.com');
    });

    describe('formulaire', () => {
      it('relève un destinataire lisible', async () => {
        const result = await analyzer.analyze(
          dudaPage(
            `<form class="dmform" data-binding="${binding([{ bindingName: 'email', value: 'x' }])}"><input name="dmformsendto" value="contact@exemple.fr"></form>`,
          ),
          settings,
        );

        const item = result.items.find(entry => entry.key === 'DATA_BINDING.form_connected');
        expect(item?.status).toBe('pass');
        expect(item?.value).toBe('contact@exemple.fr');
      });

      it('ne REPROCHE PAS un destinataire chiffré', async () => {
        // Le jeton est chiffré côté éditeur : le compter en défaut accuserait
        // une configuration correcte.
        const result = await analyzer.analyze(
          dudaPage('<form class="dmform"><input name="dmformsendto" value="a8f3e91c2b"></form>'),
          settings,
        );

        expect(
          result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.status,
        ).toBe('info');
      });

      it('AVERTIT sur un formulaire sans destinataire ni liaison', async () => {
        const result = await analyzer.analyze(dudaPage('<form class="dmform"></form>'), settings);

        expect(
          result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.status,
        ).toBe('warning');
      });
    });
  });

  describe('boutons de contact', () => {
    it('relève les numéros des boutons d’appel', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<a data-element-type="clicktocall" phone="04 72 00 00 00">Appeler</a><div data-element-type="clicktocall"><span class="phoneNumHolder">01 23 45 67 89</span></div>',
        ),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.ctc_count');
      expect(item?.label).toContain('2');
      expect(item?.value).toContain('04 72 00 00 00');
      expect(item?.value).toContain('01 23 45 67 89');
    });

    it('lit le numéro depuis un lien tel: ancêtre', async () => {
      // L'éditeur enveloppe parfois le widget dans le lien plutôt que
      // l'inverse : ne regarder que l'élément lui-même perdrait le numéro.
      const result = await analyzer.analyze(
        dudaPage(
          '<a href="tel:0472000000"><span data-element-type="clicktocall">Appeler</span></a>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.ctc_count')?.value).toBe(
        '0472000000',
      );
    });

    it('relève les adresses des boutons de courriel', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<a data-element-type="clicktomail" href="mailto:contact@exemple.fr?subject=Devis">Écrire</a>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.ctm_count')?.value).toBe(
        'contact@exemple.fr',
      );
    });

    it('compte les boutons sans exiger qu’ils portent une adresse', async () => {
      const result = await analyzer.analyze(
        dudaPage('<div data-element-type="clicktomail">Écrire</div>'),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'DATA_BINDING.ctm_count');
      expect(item?.label).toContain('1');
      expect(item?.value).toBeUndefined();
    });
  });

  describe('repli du destinataire de formulaire', () => {
    it('se rabat sur un lien mailto du formulaire', async () => {
      const result = await analyzer.analyze(
        dudaPage('<form class="dmform"><a href="mailto:devis@exemple.fr">Écrire</a></form>'),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.value).toBe(
        'devis@exemple.fr',
      );
    });

    it('se rabat sur l’action du formulaire', async () => {
      const result = await analyzer.analyze(
        dudaPage('<form class="dmform" action="mailto:action@exemple.fr"></form>'),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.value).toBe(
        'action@exemple.fr',
      );
    });

    it('se rabat enfin sur l’adresse des boutons de courriel', async () => {
      // Le formulaire et les boutons puisent à la même source : montrer
      // l'adresse connue vaut mieux que n'en montrer aucune.
      const result = await analyzer.analyze(
        dudaPage(
          '<a data-element-type="clicktomail" href="mailto:contact@exemple.fr">Écrire</a><form class="dmform"></form>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.value).toBe(
        'contact@exemple.fr',
      );
    });

    it('accepte plusieurs destinataires séparés par une virgule', async () => {
      const result = await analyzer.analyze(
        dudaPage(
          '<form class="dmform"><input name="dmformsendto" value="a@exemple.fr, b@exemple.fr"></form>',
        ),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.form_connected')?.value).toBe(
        'a@exemple.fr, b@exemple.fr',
      );
    });
  });

  describe('composants absents', () => {
    it('ne dit RIEN des composants que la page ne contient pas', async () => {
      // Reprocher l'absence d'une carte à une page qui n'en a pas ferait
      // échouer toute page sans carte.
      const result = await analyzer.analyze(dudaPage('<p>Page simple</p>'), settings);

      for (const key of [
        'DATA_BINDING.ctc_connected',
        'DATA_BINDING.map_connected',
        'DATA_BINDING.hours_connected',
        'DATA_BINDING.social_connected',
        'DATA_BINDING.form_connected',
      ]) {
        expect(result.items.some(item => item.key === key)).toBe(false);
      }
    });

    it('signale en revanche un logo introuvable', async () => {
      const result = await analyzer.analyze(dudaPage('<p>Page sans logo</p>'), settings);

      expect(
        result.items.find(entry => entry.key === 'DATA_BINDING.logo_connected')?.label,
      ).toContain('aucune liaison');
    });
  });

  describe('horaires', () => {
    it('se rabat sur le texte visible du widget', async () => {
      const result = await analyzer.analyze(
        dudaPage('<div data-element-type="open_hours">Lundi au vendredi, 9h–18h</div>'),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.hours_connected')?.value).toBe(
        'Lundi au vendredi, 9h–18h',
      );
    });

    it('ignore un jour fermé dans les horaires encodés', async () => {
      const hours = Buffer.from(
        JSON.stringify([
          { day: '0', open: '09:00', close: '18:00' },
          { day: '6', closed: true },
        ]),
      ).toString('base64');

      const result = await analyzer.analyze(
        dudaPage(`<div data-element-type="open_hours" hours_data="${hours}"></div>`),
        settings,
      );

      const value = result.items.find(entry => entry.key === 'DATA_BINDING.hours_connected')?.value;
      expect(value).toBe('Lun 09:00–18:00');
    });

    it('lit des horaires encodés sous forme d’objet', async () => {
      const hours = Buffer.from(
        JSON.stringify({ '2': { open: '08:00', close: '12:00' } }),
      ).toString('base64');

      const result = await analyzer.analyze(
        dudaPage(`<div data-element-type="open_hours" data-hours-data="${hours}"></div>`),
        settings,
      );

      expect(result.items.find(entry => entry.key === 'DATA_BINDING.hours_connected')?.value).toBe(
        'Mer 08:00–12:00',
      );
    });

    it('ignore des horaires encodés illisibles', async () => {
      const result = await analyzer.analyze(
        dudaPage('<div data-element-type="open_hours" hours_data="cGFzLWR1LWpzb24="></div>'),
        settings,
      );

      expect(result.items.some(entry => entry.key === 'DATA_BINDING.hours_connected')).toBe(true);
    });
  });

  it('constate la configuration de l’éditeur sans la noter', async () => {
    const result = await analyzer.analyze(
      dudaPage('<script>window.__DUDA__ = {};</script>'),
      settings,
    );

    const item = result.items.find(entry => entry.key === 'DATA_BINDING.duda_config');
    expect(item?.status).toBe('pass');
    expect(item?.label).toContain('détectée');
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      dudaPage('<p>x</p>'),
      makeSettings({ disabledChecks: ['DATA_BINDING'] }),
    );

    expect(result.status).toBe('na');
  });
});
