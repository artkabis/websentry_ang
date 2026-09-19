import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { CtaAnalyzer } from './cta.analyzer.js';

const analyzer = new CtaAnalyzer();
const settings = makeSettings();

describe('CtaAnalyzer', () => {
  it('valide une page qui offre bouton, téléphone et courriel', async () => {
    const result = await analyzer.analyze(
      makePage(
        '<button>Demander un devis</button><a href="tel:0123456789">Appeler</a><a href="mailto:contact@exemple.fr">Écrire</a>',
      ),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('ÉCHOUE quand la page n’offre aucun moyen d’agir', async () => {
    const result = await analyzer.analyze(makePage('<p>Texte seul</p>'), settings);

    expect(result.status).toBe('fail');
    expect(result.items.some(item => item.key === 'CTA.no_cta')).toBe(true);
  });

  describe('liens d’action', () => {
    it('reconnaît un libellé d’appel à l’action', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="/devis">Demander un devis</a><button>x</button>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'CTA.cta_links')).toBe(true);
    });

    it('NE CONFOND PAS « savoir » avec « voir »', async () => {
      // La v1 testait l'inclusion brute : « voir » se retrouve dans « savoir »,
      // « pouvoir » et « recevoir », et le rapport annonçait des appels à
      // l'action que la page n'avait pas.
      const result = await analyzer.analyze(
        makePage('<a href="/a">Nous pouvons recevoir votre dossier</a><button>x</button>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'CTA.cta_links')).toBe(false);
    });

    it('reconnaît « en savoir plus », qui est bien un appel à l’action', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="/a">En savoir plus</a><button>x</button>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'CTA.cta_links')).toBe(true);
    });

    it('compte un lien image comme un CTA visuel', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="/promo"><img src="/p.jpg" alt="Offre du mois"></a>'),
        settings,
      );

      const item = result.items.find(entry => entry.key === 'CTA.image_links');
      expect(item?.status).toBe('info');
      expect(item?.detail).toContain('Offre du mois');
    });

    it('ignore un lien vide sans contenu visuel', async () => {
      const result = await analyzer.analyze(makePage('<a href="/x"></a>'), settings);

      expect(result.items.some(item => item.key === 'CTA.image_links')).toBe(false);
    });
  });

  describe('téléphone', () => {
    it('accepte le format national français', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="tel:0123456789">Appeler</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.phone_count')?.status).toBe('pass');
    });

    it('accepte un numéro INTERNATIONAL hors France', async () => {
      // La v1 n'acceptait que +33 : un numéro belge ou suisse, parfaitement
      // valide, était signalé comme une erreur sur les sites qui en ont.
      const result = await analyzer.analyze(
        makePage('<a href="tel:+3221234567">Appeler</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.phone_count')?.status).toBe('pass');
    });

    it('tolère les séparateurs de lisibilité', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="tel:01 23 45 67 89">Appeler</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.phone_count')?.status).toBe('pass');
    });

    it('ÉCHOUE sur un numéro manifestement invalide', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="tel:12">Appeler</a><button>x</button>'),
        settings,
      );

      expect(result.status).toBe('fail');
    });

    it('AVERTIT en l’absence de lien téléphonique', async () => {
      const result = await analyzer.analyze(makePage('<button>Envoyer</button>'), settings);

      expect(result.items.some(item => item.key === 'CTA.no_phone')).toBe(true);
    });
  });

  describe('courriel', () => {
    it('ignore les paramètres d’un mailto', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="mailto:contact@exemple.fr?subject=Devis">Écrire</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.email_count')?.status).toBe('pass');
    });

    it('décode une adresse percent-encodée', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="mailto:contact%40exemple.fr">Écrire</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.email_count')?.status).toBe('pass');
    });

    it('ÉCHOUE sur une adresse invalide', async () => {
      const result = await analyzer.analyze(
        makePage('<a href="mailto:pas-une-adresse">Écrire</a><button>x</button>'),
        settings,
      );

      expect(result.status).toBe('fail');
    });
  });

  describe('boutons', () => {
    it('ne reproche RIEN à un bouton porteur d’une icône', async () => {
      // Un hamburger ou une flèche de carrousel n'a pas de texte par nature,
      // mais il a un contenu : il n'est pas « vide ».
      const result = await analyzer.analyze(
        makePage(
          '<button><svg></svg></button><a href="tel:0123456789">a</a><a href="mailto:a@b.fr">b</a>',
        ),
        settings,
      );

      expect(result.items.some(item => item.key === 'CTA.buttons_empty')).toBe(false);
      expect(result.status).toBe('pass');
    });

    it('SIGNALE sans pénaliser un bouton réellement vide', async () => {
      // `info` et non `warning` : c'est l'affaire du critère d'accessibilité,
      // et le compter deux fois exagérerait sa gravité.
      const result = await analyzer.analyze(
        makePage('<button></button><a href="tel:0123456789">a</a><a href="mailto:a@b.fr">b</a>'),
        settings,
      );

      expect(result.items.find(item => item.key === 'CTA.buttons_empty')?.status).toBe('info');
      expect(result.status).toBe('pass');
    });

    it('reconnaît un bouton étiqueté par aria-label', async () => {
      const result = await analyzer.analyze(
        makePage('<button aria-label="Ouvrir le menu"></button>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'CTA.buttons_empty')).toBe(false);
    });
  });

  it('ANNULE la note quand téléphone ET courriel sont invalides', async () => {
    // Aucun moyen de contact de la page ne fonctionne : le visiteur ne peut
    // rien faire.
    const result = await analyzer.analyze(
      makePage('<a href="tel:12">a</a><a href="mailto:cassé">b</a><button>x</button>'),
      settings,
    );

    expect(result.globalScore).toBe(0);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage('<p>x</p>'),
      makeSettings({ disabledChecks: ['CTA'] }),
    );

    expect(result.status).toBe('na');
  });
});
