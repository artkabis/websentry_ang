import { describe, expect, it } from 'vitest';
import {
  anchorMatchesCompany,
  companyNameTokens,
  computeFBetaScore,
  hrefSegments,
  isAboutUrl,
  isAddressAnchor,
  isContactOrLocationUrl,
  isEmailAnchor,
  isPhoneAnchor,
  isShopLink,
  normalize,
  phonetic,
  splitUrlSegment,
  stem,
  stripPlural,
  tokenVsSegment,
  tokenize,
} from './anchor-text.scoring.js';

const PAGE = 'https://exemple.fr/accueil';

describe('normalisation du texte', () => {
  it('retire les accents et la ponctuation', () => {
    expect(normalize('Réalisations & Références !')).toBe('realisations references');
  });

  it('découpe en mots significatifs', () => {
    // Les mots-outils disparaissent — « nos » et « de » ne disent rien de la
    // destination d'un lien, et les garder diluerait la précision.
    expect(tokenize('Nos services de plomberie')).toEqual(['services', 'plomberie']);
  });

  it('rend une liste vide pour un texte sans mot', () => {
    expect(tokenize('!!! ???')).toEqual([]);
  });
});

describe('racinisation', () => {
  it('ramène un pluriel au singulier', () => {
    expect(stripPlural('services')).toBe('service');
    expect(stripPlural('chantiers')).toBe('chantier');
  });

  it('rapproche un pluriel irrégulier SANS le ramener à son singulier', () => {
    // La règle en `-aux` rend « traval », et non « travail » : les deux formes
    // ne se confondent donc pas. C'est la comparaison par distance d'édition,
    // en aval, qui les rapproche — d'où un score élevé mais non maximal. Le
    // test fixe cette limite plutôt que de laisser croire à une lemmatisation
    // complète.
    expect(stripPlural('travaux')).not.toBe(stripPlural('travail'));
    expect(tokenVsSegment('travaux', 'travail')).toBeGreaterThan(0.6);
  });

  it('rapproche les formes d’un même mot', () => {
    // « aménager » et « aménagements » doivent se rejoindre : c'est ce qui
    // permet de reconnaître /amenagements depuis l'ancre « aménager ».
    expect(stem('amenager')).toBe(stem('amenagements'));
  });

  it('laisse un mot court intact', () => {
    expect(stem('toit')).toBe('toit');
  });
});

describe('phonétique', () => {
  it('rapproche deux orthographes d’un même son', () => {
    // La transcription encaisse les fautes de frappe d'une URL rédigée à la
    // main, cas fréquent sur les sites d'artisans.
    expect(phonetic('photo')).toBe(phonetic('foto'));
  });

  it('rend une chaîne vide pour une entrée vide', () => {
    expect(phonetic('')).toBe('');
  });
});

describe('segments d’URL', () => {
  it('découpe un chemin en mots', () => {
    expect(hrefSegments('/nos-services/plomberie', PAGE)).toEqual(['services', 'plomberie']);
  });

  it('IGNORE les segments purement numériques', () => {
    // « /123 » n'apprend rien : le retenir ferait croire à un segment
    // comparable et produirait une discordance artificielle.
    expect(hrefSegments('/blog/123', PAGE)).toEqual(['blog']);
  });

  it('écarte une année', () => {
    expect(hrefSegments('/actualites/2024', PAGE)).toEqual(['actualites']);
  });

  it('rend une liste vide pour la racine', () => {
    expect(hrefSegments('/', PAGE)).toEqual([]);
  });

  it('découpe un segment collé', () => {
    expect(splitUrlSegment('nos-services_plomberie')).toEqual(['services', 'plomberie']);
  });
});

describe('score de concordance', () => {
  it('note haut une ancre qui reprend l’URL', () => {
    const { fBeta } = computeFBetaScore(['services', 'plomberie'], ['services', 'plomberie']);

    expect(fBeta).toBeGreaterThan(0.9);
  });

  it('note bas une ancre sans rapport', () => {
    const { fBeta } = computeFBetaScore(['toiture', 'chantiers'], ['recrutement']);

    expect(fBeta).toBeLessThan(0.35);
  });

  it('PRIVILÉGIE la précision sur le rappel', () => {
    // β = 0,5 : une ancre dont chaque mot porte vaut mieux qu'une ancre
    // bavarde qui couvre l'URL en la noyant. Les deux cas ci-dessous ont des
    // précision et rappel exactement inversés — seule la pondération les
    // départage.
    const precise = computeFBetaScore(['plomberie'], ['plomberie', 'services', 'lyon']);
    const verbose = computeFBetaScore(['plomberie', 'devis', 'urgence'], ['plomberie']);

    expect(precise.precision).toBeGreaterThan(precise.recall);
    expect(verbose.recall).toBeGreaterThan(verbose.precision);
    expect(precise.fBeta).toBeGreaterThan(verbose.fBeta);
  });

  it('rend zéro sans matière à comparer', () => {
    expect(computeFBetaScore([], ['services']).fBeta).toBe(0);
    expect(computeFBetaScore(['services'], []).fBeta).toBe(0);
  });

  it('reconnaît un mot identique à son segment', () => {
    expect(tokenVsSegment('plomberie', 'plomberie')).toBe(1);
  });

  it('reconnaît une variante fléchie', () => {
    expect(tokenVsSegment('amenager', 'amenagements')).toBeGreaterThan(0.8);
  });

  it('ne rapproche pas deux mots étrangers l’un à l’autre', () => {
    expect(tokenVsSegment('plomberie', 'recrutement')).toBeLessThan(0.3);
  });
});

describe('pré-classement par intention', () => {
  it('reconnaît une adresse postale', () => {
    expect(isAddressAnchor('12 rue de la Paix')).toBe(true);
    expect(isAddressAnchor('69002 Lyon')).toBe(true);
    expect(isAddressAnchor('Nos services')).toBe(false);
  });

  it('reconnaît un numéro de téléphone', () => {
    expect(isPhoneAnchor('04 72 00 00 00')).toBe(true);
    expect(isPhoneAnchor('+33 4 72 00 00 00')).toBe(true);
    expect(isPhoneAnchor('2024')).toBe(false);
  });

  it('reconnaît une adresse électronique', () => {
    expect(isEmailAnchor('contact@exemple.fr')).toBe(true);
    expect(isEmailAnchor('contact chez exemple')).toBe(false);
  });

  it('reconnaît une page de contact ou de localisation', () => {
    expect(isContactOrLocationUrl(['nous', 'contacter'])).toBe(true);
    expect(isContactOrLocationUrl(['acces'])).toBe(true);
    expect(isContactOrLocationUrl(['boutique'])).toBe(false);
  });

  it('reconnaît une page « à propos »', () => {
    expect(isAboutUrl(['a', 'propos'])).toBe(true);
    expect(isAboutUrl(['notre', 'histoire'])).toBe(true);
    expect(isAboutUrl(['tarifs'])).toBe(false);
  });
});

describe('raison sociale', () => {
  it('retire les formes juridiques', () => {
    // « SARL » ou « SAS » n'identifient personne : les garder ferait
    // correspondre toutes les ancres portant ces trois lettres.
    expect(companyNameTokens('Boulangerie Durand SARL')).toEqual(['boulangerie', 'durand']);
  });

  it('rend une liste vide pour un nom vide', () => {
    expect(companyNameTokens('')).toEqual([]);
  });

  it('reconnaît une ancre qui reprend le nom', () => {
    expect(anchorMatchesCompany(['boulangerie', 'durand'], ['boulangerie', 'durand'])).toBe(true);
  });

  it('refuse une ancre sans rapport', () => {
    expect(anchorMatchesCompany(['nos', 'tarifs'], ['boulangerie', 'durand'])).toBe(false);
  });
});

describe('liens de boutique', () => {
  it('reconnaît une sous-page de la boutique', () => {
    expect(isShopLink('/boutique/pain-complet', PAGE, '/boutique')).toBe(true);
  });

  it('CONSERVE la page principale de la boutique', () => {
    // Seules les fiches produits sont écartées : la page d'entrée de la
    // boutique est une page éditoriale comme une autre.
    expect(isShopLink('/boutique', PAGE, '/boutique')).toBe(false);
  });

  it('fait abstraction du préfixe d’aperçu', () => {
    // Le chemin porte `/site/{identifiant}` en aperçu et rien en production :
    // comparer les chemins bruts ne marcherait que dans un des deux cas.
    expect(
      isShopLink(
        '/site/abc12345def/boutique/pain',
        'https://exemple.fr/site/abc12345def/accueil',
        '/site/abc12345def/boutique',
      ),
    ).toBe(true);
  });

  it('refuse une URL illisible plutôt que de deviner', () => {
    expect(isShopLink('::pas-une-url', 'aussi-invalide', '/boutique')).toBe(false);
  });
});
