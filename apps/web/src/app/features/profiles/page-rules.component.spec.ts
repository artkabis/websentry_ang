import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { CheckMeta, PageRule } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import { PageRulesComponent } from './page-rules.component';

const CHECKS: CheckMeta[] = [
  { id: 'METAS', title: 'Métadonnées', group: 'SEO' },
  { id: 'CTA', title: 'Boutons d’action', group: 'Design' },
];

@Component({
  standalone: true,
  imports: [PageRulesComponent],
  template: `<ws-page-rules [(rules)]="rules" [checks]="checks" [disabled]="disabled()" />`,
})
class HoteTest {
  readonly rules = signal<PageRule[]>([]);
  readonly checks = CHECKS;
  readonly disabled = signal(false);
}

async function monter(rules: PageRule[] = [], disabled = false) {
  const vue = await render(HoteTest, { providers: [provideZonelessChangeDetection()] });
  vue.fixture.componentInstance.rules.set(rules);
  vue.fixture.componentInstance.disabled.set(disabled);
  vue.fixture.detectChanges();
  return { ...vue, regles: vue.fixture.componentInstance.rules };
}

describe('PageRulesComponent', () => {
  const user = userEvent.setup();

  it('explique l’absence de règle au lieu de ne rien montrer', async () => {
    await monter();

    expect(screen.getByText(/le profil s'appliq/i)).toBeTruthy();
  });

  it('ajoute une règle vide, prête à être nommée', async () => {
    const { regles } = await monter();

    await user.click(screen.getByRole('button', { name: 'Ajouter une règle' }));

    expect(regles()).toEqual([{ label: '', patterns: [] }]);
  });

  it('SIGNALE une règle sans nom', async () => {
    // Le nom identifie la règle dans le rapport : sans lui, l'analyste voit
    // une exception s'appliquer sans savoir laquelle.
    await monter([{ label: '', patterns: ['contact'] }]);

    expect(screen.getByRole('alert').textContent).toContain('Nommez la règle');
  });

  it('SIGNALE une règle qui ne vise aucune page', async () => {
    // Une règle sans motif ne s'applique jamais : elle donne l'illusion d'une
    // exception configurée.
    await monter([{ label: 'Contact', patterns: [] }]);

    expect(screen.getByText(/ne s'appliquera à aucune page/)).toBeTruthy();
  });

  it('retire une règle', async () => {
    const { regles } = await monter([
      { label: 'Contact', patterns: ['contact'] },
      { label: 'Légal', patterns: ['mentions'] },
    ]);

    await user.click(screen.getByRole('button', { name: 'Retirer la règle Contact' }));

    expect(regles()).toEqual([{ label: 'Légal', patterns: ['mentions'] }]);
  });

  it('désactive un critère pour ces pages', async () => {
    const { regles } = await monter([{ label: 'Légal', patterns: ['mentions'] }]);

    await user.click(screen.getByRole('checkbox', { name: 'Boutons d’action — règle Légal' }));

    expect(regles()[0]?.disabledChecks).toEqual(['CTA']);
  });

  it('RETIRE la clé quand plus aucun critère n’est désactivé', async () => {
    // Un tableau vide et une absence se lisent pareil, mais le premier gonfle
    // le profil d'une clé qui ne dit rien.
    const { regles } = await monter([
      { label: 'Légal', patterns: ['mentions'], disabledChecks: ['CTA'] },
    ]);

    await user.click(screen.getByRole('checkbox', { name: 'Boutons d’action — règle Légal' }));

    expect('disabledChecks' in (regles()[0] ?? {})).toBe(false);
  });

  it('surcharge un seuil', async () => {
    const { regles } = await monter([{ label: 'Contact', patterns: ['contact'] }]);

    await user.type(screen.getByLabelText('Mots — minimum — règle Contact'), '50');

    expect(regles()[0]?.settings).toEqual({ content: { minWords: 50 } });
  });

  it('TRAITE un champ vidé comme une absence de surcharge, jamais comme un zéro', async () => {
    // Un zéro est un seuil, et un seuil à zéro rend le critère inopérant au
    // lieu de laisser le profil décider.
    const { regles } = await monter([
      { label: 'Contact', patterns: ['contact'], settings: { content: { minWords: 50 } } },
    ]);

    await user.clear(screen.getByLabelText('Mots — minimum — règle Contact'));

    expect('settings' in (regles()[0] ?? {})).toBe(false);
  });

  it('garde les autres seuils quand on en vide un seul', async () => {
    const { regles } = await monter([
      {
        label: 'Contact',
        patterns: ['contact'],
        settings: { content: { minWords: 50, warningWords: 80 } },
      },
    ]);

    await user.clear(screen.getByLabelText('Mots — minimum — règle Contact'));

    expect(regles()[0]?.settings).toEqual({ content: { warningWords: 80 } });
  });

  it('N’ÉDITE RIEN sans les droits', async () => {
    const { regles } = await monter([{ label: 'Contact', patterns: ['contact'] }], true);

    const ajouter = screen.getByRole<HTMLButtonElement>('button', { name: 'Ajouter une règle' });
    expect(ajouter.disabled).toBe(true);
    await user.click(ajouter);
    expect(regles()).toHaveLength(1);
  });
});
