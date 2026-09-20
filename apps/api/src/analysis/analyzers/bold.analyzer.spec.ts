import { describe, expect, it } from 'vitest';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { BoldAnalyzer } from './bold.analyzer.js';

const analyzer = new BoldAnalyzer();
const settings = makeSettings({ bold: { min: 2, max: 4, minParentWords: 10 } });

/** Paragraphe assez fourni pour satisfaire le contexte exigé. */
function paragraph(inner: string): string {
  return `<p>${inner} un texte de contexte assez long pour dépasser la dizaine de mots attendue ici</p>`;
}

describe('BoldAnalyzer', () => {
  it('valide une mise en gras contextualisée et en quantité juste', async () => {
    const result = await analyzer.analyze(
      makePage(paragraph('<strong>pain</strong> et <b>levain</b>')),
      settings,
    );

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  it('AVERTIT quand la page n’a aucun gras', async () => {
    const result = await analyzer.analyze(makePage('<p>Rien en gras ici</p>'), settings);

    expect(result.status).toBe('warning');
    expect(result.items[0]?.key).toBe('BOLD.none');
    expect(result.globalScore).toBe(2);
  });

  it('AVERTIT sous le minimum', async () => {
    const result = await analyzer.analyze(makePage(paragraph('<b>seul</b>')), settings);

    expect(result.items.some(item => item.key === 'BOLD.too_few')).toBe(true);
    expect(result.status).toBe('warning');
  });

  it('AVERTIT au-delà du maximum — trop d’emphase ne distingue plus rien', async () => {
    const inner = Array.from({ length: 6 }, (_, i) => `<b>mot${i}</b>`).join(' ');
    const result = await analyzer.analyze(makePage(paragraph(inner)), settings);

    expect(result.items.some(item => item.key === 'BOLD.too_many')).toBe(true);
  });

  it('SIGNALE un gras isolé dans un contexte trop pauvre', async () => {
    // Un mot en gras dans un paragraphe de trois mots ne met rien en valeur :
    // il est le paragraphe.
    const result = await analyzer.analyze(
      makePage('<p><strong>Promo</strong></p><p><b>Soldes</b></p>'),
      settings,
    );

    const poor = result.items.find(item => item.key === 'BOLD.context_poor');
    expect(poor?.status).toBe('warning');
    expect(poor?.locator).toBeDefined();
  });

  it('ÉCHOUE sur une balise en gras vide', async () => {
    const result = await analyzer.analyze(
      makePage(paragraph('<strong>pain</strong> <b></b> <strong>levain</strong>')),
      settings,
    );

    expect(result.status).toBe('fail');
    expect(result.globalScore).toBe(1);
  });

  it('note 4 sur un seul avertissement et 3 dès le deuxième', async () => {
    // Barème propre au critère, repris de la v1 : il garde les scores
    // comparables à ceux déjà stockés en base.
    const single = await analyzer.analyze(makePage(paragraph('<b>seul</b>')), settings);
    const double = await analyzer.analyze(makePage('<p><b>seul</b></p>'), settings);

    expect(single.globalScore).toBe(4);
    expect(double.globalScore).toBe(3);
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      makePage(paragraph('<b>x</b>')),
      makeSettings({ disabledChecks: ['BOLD'] }),
    );

    expect(result.status).toBe('na');
  });
});
