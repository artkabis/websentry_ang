import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { ScoreDialComponent } from './score-dial.component';
import { StatusBadgeComponent } from './status-badge.component';

async function mountDial(score: number, qualifier = '') {
  await render(ScoreDialComponent, {
    providers: [provideZonelessChangeDetection()],
    inputs: { score, qualifier },
  });
}

describe('ScoreDialComponent', () => {
  it('affiche le score à la française', async () => {
    await mountDial(4.25);
    expect(screen.getByText('4,3')).toBeTruthy();
  });

  it('ANNONCE le score et son sens, jamais des coordonnées SVG', async () => {
    // Un lecteur d'écran doit entendre « score 4,2 sur 5 — page conforme ».
    await mountDial(4.2, 'Page conforme');
    expect(screen.getByRole('img', { name: 'Score 4,2 sur 5 — Page conforme' })).toBeTruthy();
  });

  it('reste annonçable sans qualificatif', async () => {
    await mountDial(3);
    expect(screen.getByRole('img', { name: 'Score 3,0 sur 5' })).toBeTruthy();
  });

  it.each([
    [5, 'ok'],
    [4, 'ok'],
    [3.5, 'warn'],
    [3, 'warn'],
    [1, 'danger'],
  ])('colore l’arc selon le palier (%s)', async (score, hue) => {
    await mountDial(score);
    const arc = document.querySelectorAll('circle')[1];
    expect(arc?.getAttribute('class')).toContain(hue);
  });

  it('BORNE l’arc aux extrêmes de l’échelle', async () => {
    // Une donnée corrompue ne doit pas produire un arc qui déborde du cercle.
    await mountDial(12);
    const arc = document.querySelectorAll('circle')[1];
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBe(0);
  });

  it('masque le dessin aux technologies d’assistance', async () => {
    await mountDial(4);
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('StatusBadgeComponent', () => {
  it.each([
    ['pass', 'Conforme'],
    ['info', 'Pour information'],
    ['warning', 'À surveiller'],
    ['fail', 'En échec'],
    ['na', 'Non applicable'],
  ] as const)('énonce le statut %s en toutes lettres', async (status, label) => {
    // Une pastille rouge est invisible pour un lecteur d'écran et
    // indistinguable d'une verte pour une part notable des utilisateurs.
    await render(StatusBadgeComponent, {
      providers: [provideZonelessChangeDetection()],
      inputs: { status },
    });
    expect(screen.getByText(label)).toBeTruthy();
  });
});
