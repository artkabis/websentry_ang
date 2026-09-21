import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TokenListComponent } from './token-list.component';

/**
 * Hôte minimal : `model()` se teste par sa LIAISON, pas par une entrée posée.
 * Un test qui écrirait la valeur à la main ne dirait rien du signal rendu au
 * parent — qui est précisément le contrat du composant.
 */
@Component({
  standalone: true,
  imports: [TokenListComponent],
  template: `
    <ws-token-list
      [(items)]="items"
      addLabel="Mot à exclure"
      [emptyLabel]="emptyLabel()"
      [disabled]="disabled()"
      [maxItems]="maxItems()"
    />
  `,
})
class HoteTest {
  readonly items = signal<string[]>([]);
  readonly emptyLabel = signal('Aucune valeur.');
  readonly disabled = signal(false);
  readonly maxItems = signal(1000);
}

async function monter(items: string[] = [], over: Partial<Record<string, unknown>> = {}) {
  const vue = await render(HoteTest, { providers: [provideZonelessChangeDetection()] });
  const hote = vue.fixture.componentInstance;
  hote.items.set(items);
  if (over['emptyLabel']) hote.emptyLabel.set(over['emptyLabel'] as string);
  if (over['disabled']) hote.disabled.set(over['disabled'] as boolean);
  if (over['maxItems']) hote.maxItems.set(over['maxItems'] as number);
  vue.fixture.detectChanges();
  return { ...vue, valeurs: hote.items };
}

describe('TokenListComponent', () => {
  it('ajoute une valeur saisie', async () => {
    const { valeurs, fixture } = await monter();

    await userEvent.type(screen.getByLabelText('Mot à exclure'), 'le');
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter : Mot à exclure' }));
    fixture.detectChanges();

    expect(valeurs()).toEqual(['le']);
    expect(screen.getByRole('button', { name: 'Retirer le' })).toBeTruthy();
  });

  it('valide aussi à la touche Entrée', async () => {
    // Saisir puis viser un bouton à la souris est le geste le plus lent d'une
    // liste qu'on remplit à vingt valeurs.
    const { valeurs } = await monter();

    await userEvent.type(screen.getByLabelText('Mot à exclure'), 'des{Enter}');

    expect(valeurs()).toEqual(['des']);
  });

  it('retire une valeur', async () => {
    const { valeurs } = await monter(['le', 'la']);

    await userEvent.click(screen.getByRole('button', { name: 'Retirer le' }));

    expect(valeurs()).toEqual(['la']);
  });

  it('REFUSE un doublon, et le dit', async () => {
    // Ajouter en silence laisserait l'utilisateur chercher où sa valeur est
    // passée ; l'ajouter deux fois fausserait le compte.
    const { valeurs } = await monter(['le']);

    await userEvent.type(screen.getByLabelText('Mot à exclure'), 'le{Enter}');

    expect(valeurs()).toEqual(['le']);
    expect(screen.getByRole('alert').textContent).toContain('figure déjà');
  });

  it('normalise avant de comparer', async () => {
    // « Le » et « le » sont le même mot-outil : les accepter tous deux
    // gonflerait la liste sans changer l'analyse.
    const { valeurs } = await monter(['le']);

    await userEvent.type(screen.getByLabelText('Mot à exclure'), '  LE  {Enter}');

    expect(valeurs()).toEqual(['le']);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('refuse une saisie vide', async () => {
    const { valeurs } = await monter();

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter : Mot à exclure' }));

    expect(valeurs()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Saisissez');
  });

  it('REFUSE au-delà du plafond du schéma', async () => {
    // Le plafond est celui de l'API : laisser dépasser produirait un refus
    // serveur après coup, sur une liste qu'on croyait enregistrée.
    const { valeurs } = await monter(['un', 'deux'], { maxItems: 2 });

    await userEvent.type(screen.getByLabelText('Mot à exclure'), 'trois{Enter}');

    expect(valeurs()).toEqual(['un', 'deux']);
    expect(screen.getByRole('alert').textContent).toContain('pleine');
  });

  it('annonce ce qu’il reste de place', async () => {
    await monter(['un'], { maxItems: 3 });

    expect(screen.getByText('1 sur 3 au plus')).toBeTruthy();
  });

  it('explique une liste vide au lieu de ne rien montrer', async () => {
    await monter([], { emptyLabel: 'Aucun mot exclu — chaque mot comptera.' });

    expect(screen.getByText('Aucun mot exclu — chaque mot comptera.')).toBeTruthy();
  });

  it('N’ÉDITE RIEN quand la liste est en lecture seule', async () => {
    const { valeurs } = await monter(['le'], { disabled: true });

    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Ajouter : Mot à exclure' }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retirer le' }).disabled).toBe(
      true,
    );

    // Et pas seulement grisés : le clic ne doit rien changer.
    await userEvent.click(screen.getByRole('button', { name: 'Retirer le' }));
    expect(valeurs()).toEqual(['le']);
  });
});
