import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SectionPlianteComponent } from './section-pliante.component';

@Component({
  standalone: true,
  imports: [SectionPlianteComponent],
  template: `
    <ws-section-pliante
      [titre]="titre()"
      [resume]="resume()"
      [cle]="cle()"
      [ouvertParDefaut]="ouvert()"
    >
      <button type="button">Contenu</button>
    </ws-section-pliante>
  `,
})
class HoteTest {
  readonly titre = signal('Pondération des critères');
  readonly resume = signal('3 critères pondérés sur mesure');
  readonly cle = signal<string | null>(null);
  readonly ouvert = signal(false);
}

async function monter(over: Partial<{ cle: string; ouvert: boolean }> = {}) {
  const vue = await render(HoteTest, { providers: [provideZonelessChangeDetection()] });
  const hote = vue.fixture.componentInstance;
  if (over.cle !== undefined) hote.cle.set(over.cle);
  if (over.ouvert !== undefined) hote.ouvert.set(over.ouvert);
  vue.fixture.detectChanges();
  return vue;
}

/** L'état plié se lit sur l'élément natif, pas sur une classe. */
function ouverte(): boolean {
  return document.querySelector('details')?.open ?? false;
}

describe('SectionPlianteComponent', () => {
  beforeEach(() => localStorage.clear());

  it('est repliée par défaut', async () => {
    await monter();

    expect(ouverte()).toBe(false);
  });

  it('s’ouvre d’emblée quand la section le demande', async () => {
    await monter({ ouvert: true });

    expect(ouverte()).toBe(true);
  });

  it('ANNONCE son contenu même repliée', async () => {
    // Un en-tête qui ne dirait que son titre obligerait à ouvrir la section
    // pour savoir si elle mérite d'être ouverte.
    await monter();

    expect(screen.getByText('3 critères pondérés sur mesure')).toBeTruthy();
  });

  it('se déplie au clavier, comme tout élément de dépliage natif', async () => {
    const { fixture } = await monter();

    await userEvent.click(screen.getByText('Pondération des critères'));
    fixture.detectChanges();

    expect(ouverte()).toBe(true);
  });

  it('RETIENT l’ouverture quand une clé est fournie', async () => {
    const { fixture } = await monter({ cle: 'ponderation' });

    await userEvent.click(screen.getByText('Pondération des critères'));
    fixture.detectChanges();

    expect(localStorage.getItem('websentry.section.ponderation')).toBe('1');
  });

  it('ROUVRE une section retenue ouverte', async () => {
    localStorage.setItem('websentry.section.ponderation', '1');

    await monter({ cle: 'ponderation' });

    expect(ouverte()).toBe(true);
  });

  it('RETIENT aussi la fermeture d’une section ouverte par défaut', async () => {
    // Sans cela, une section qu'on referme se rouvrirait à chaque visite.
    localStorage.setItem('websentry.section.metadonnees', '0');

    await monter({ cle: 'metadonnees', ouvert: true });

    expect(ouverte()).toBe(false);
  });

  it('ne retient rien sans clé', async () => {
    const { fixture } = await monter();

    await userEvent.click(screen.getByText('Pondération des critères'));
    fixture.detectChanges();

    expect(localStorage.length).toBe(0);
  });
});
