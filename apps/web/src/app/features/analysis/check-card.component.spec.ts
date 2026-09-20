import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { CheckItem, CheckResult } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import { CheckCardComponent } from './check-card.component';

function check(over: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'METAS',
    checkTitle: 'Balises méta',
    globalScore: 1,
    status: 'fail',
    items: [],
    summary: 'Un title absent.',
    recommendations: ['Ajouter une balise title'],
    ...over,
  };
}

async function mount(result: CheckResult) {
  await render(CheckCardComponent, {
    providers: [provideZonelessChangeDetection()],
    inputs: { check: result, pageUrl: 'https://exemple.fr/' },
  });
}

const items = (count: number): CheckItem[] =>
  Array.from({ length: count }, (_, i) => ({ label: `Point ${i}`, status: 'fail' as const }));

describe('CheckCardComponent', () => {
  it('est REPLIÉ par défaut', async () => {
    await mount(check({ items: items(1) }));
    const toggle = screen.getByRole('button', { name: /Balises méta/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('s’ouvre au clavier comme à la souris', async () => {
    // L'ouverture est un <button> et non un <div> cliquable : elle est donc
    // actionnable au clavier sans aucun gestionnaire supplémentaire.
    await mount(check({ items: items(1) }));
    screen.getByRole('button', { name: /Balises méta/ }).focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: /Balises méta/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('PLAFONNE les points affichés et propose le reste', async () => {
    // Un critère peut en porter des dizaines — quarante images sans alt. Tout
    // dérouler ferait abandonner avant la fin.
    await mount(check({ items: items(20) }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));

    expect(screen.queryByText('Point 19')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Afficher les 12 point/ }));
    expect(screen.getByText('Point 19')).toBeTruthy();
  });

  it('n’affiche aucun bouton « reste » quand tout tient', async () => {
    await mount(check({ items: items(3) }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));
    expect(screen.queryByText(/Afficher les/)).toBeNull();
  });

  it('OUVRE la page sur l’élément fautif', async () => {
    await mount(
      check({
        items: [{ label: 'Title manquant', status: 'fail', locator: { text: 'Accueil' } }],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));

    const link = screen.getByRole<HTMLAnchorElement>('link', { name: 'Voir dans la page' });
    expect(link.href).toContain('#:~:text=Accueil');
    // Cible externe : `noopener` évite que la page analysée accède à l'onglet
    // d'origine par `window.opener`.
    expect(link.rel).toContain('noopener');
  });

  it('n’affiche pas de lien sans ancrage', async () => {
    await mount(check({ items: [{ label: 'Sans ancrage', status: 'fail' }] }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));
    expect(screen.queryByRole('link', { name: 'Voir dans la page' })).toBeNull();
  });

  it('montre les recommandations AVANT le détail', async () => {
    await mount(check({ items: items(1), recommendations: ['Ajouter une balise title'] }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));

    const panel = screen.getByText('Que faire').closest('div');
    expect(panel).toBeTruthy();
    expect(screen.getByText('Ajouter une balise title')).toBeTruthy();
  });

  it('n’affiche pas de bloc « que faire » sans recommandation', async () => {
    await mount(check({ items: items(1), recommendations: [] }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));
    expect(screen.queryByText('Que faire')).toBeNull();
  });

  it('affiche l’extrait de source quand il existe', async () => {
    await mount(check({ items: [{ label: 'x', status: 'fail', source: '<title></title>' }] }));
    await userEvent.click(screen.getByRole('button', { name: /Balises méta/ }));
    expect(screen.getByText('<title></title>')).toBeTruthy();
  });
});
