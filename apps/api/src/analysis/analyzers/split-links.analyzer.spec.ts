import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { SplitLinksAnalyzer } from './split-links.analyzer.js';

const analyzer = new SplitLinksAnalyzer();
const settings = makeSettings();

function content(inner: string) {
  return makePage(`<div class="dmNewParagraph">${inner}</div>`);
}

describe('SplitLinksAnalyzer', () => {
  it('se déclare NON APPLICABLE hors des blocs de contenu éditorial', async () => {
    // Dans un menu ou un pied de page, des liens adjacents vers la même cible
    // sont normaux : y appliquer le critère produirait du bruit.
    const result = await analyzer.analyze(
      makePage('<nav><a href="/a">a</a><a href="/a">b</a></nav>'),
      settings,
    );

    expect(result.status).toBe('na');
  });

  it('ne signale rien sur un contenu bien rédigé', async () => {
    const result = await analyzer.analyze(
      content('<p>Voir notre <a href="/p">page produit</a> pour en savoir plus.</p>'),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  describe('liens coupés', () => {
    it('DÉTECTE un lien collé au mot précédent', async () => {
      const result = await analyzer.analyze(
        content('<p>une grande<a href="/h">hauteur</a> sous plafond</p>'),
        settings,
      );

      expect(result.status).toBe('fail');
      expect(result.items.some(item => item.key === 'SPLIT.split_found')).toBe(true);
    });

    it('ancre chaque occurrence pour la retrouver dans la page', async () => {
      const result = await analyzer.analyze(
        content('<p>une grande<a href="/h">hauteur</a></p>'),
        settings,
      );

      const occurrence = result.items.find(item => item.key === 'SPLIT.split_item');
      expect(occurrence?.locator).toEqual({ text: 'hauteur' });
      // `info` : l'item de synthèse porte déjà la sanction, la compter deux
      // fois exagérerait la gravité.
      expect(occurrence?.status).toBe('info');
    });

    it('accepte un espace avant le lien', async () => {
      const result = await analyzer.analyze(
        content('<p>une grande <a href="/h">hauteur</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_split')).toBe(true);
    });

    it('accepte une ponctuation ouvrante', async () => {
      const result = await analyzer.analyze(
        content('<p>voir (<a href="/h">la notice</a>)</p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_split')).toBe(true);
    });

    it('n’accuse PAS une unité de mesure', async () => {
      // « 30m » suivi d'un lien n'est pas un lien coupé.
      const result = await analyzer.analyze(
        content('<p>sur 30 m<a href="/d">de long</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_split')).toBe(true);
    });

    it('ignore un lien purement visuel', async () => {
      const result = await analyzer.analyze(
        content('<p>texte<a href="/i"><img src="/i.png" alt=""></a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_split')).toBe(true);
    });
  });

  describe('doublons consécutifs', () => {
    it('DÉTECTE deux liens adjacents vers la même cible', async () => {
      const result = await analyzer.analyze(
        content('<p><a href="/p">Notre</a><a href="/p">produit</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.duplicate_found')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('traverse les balises intermédiaires', async () => {
      // Deux liens dans des <span> distincts se touchent à l'écran : les
      // déclarer éloignés raterait le défaut.
      const result = await analyzer.analyze(
        content('<p><span><a href="/p">Notre</a></span><span><a href="/p">produit</a></span></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.duplicate_found')).toBe(true);
    });

    it('NE GROUPE PAS deux liens séparés par du texte', async () => {
      const result = await analyzer.analyze(
        content('<p><a href="/p">Notre</a> et aussi <a href="/p">notre produit</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_duplicate')).toBe(true);
    });

    it('ignore les paramètres et les ancres dans la comparaison', async () => {
      const result = await analyzer.analyze(
        content('<p><a href="/p?utm=a">Notre</a><a href="/p#bas">produit</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.duplicate_found')).toBe(true);
    });

    it('distingue deux cibles différentes', async () => {
      const result = await analyzer.analyze(
        content('<p><a href="/a">Un</a><a href="/b">Deux</a></p>'),
        settings,
      );

      expect(result.items.some(item => item.key === 'SPLIT.no_duplicate')).toBe(true);
    });
  });

  it('ANNULE la note quand les deux défauts coexistent', async () => {
    const result = await analyzer.analyze(
      content(
        '<p>une grande<a href="/h">hauteur</a></p><p><a href="/p">a</a><a href="/p">b</a></p>',
      ),
      settings,
    );

    expect(result.globalScore).toBe(0);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      content('<p>x</p>'),
      makeSettings({ disabledChecks: ['SPLIT_LINKS'] }),
    );

    expect(result.status).toBe('na');
  });
});
