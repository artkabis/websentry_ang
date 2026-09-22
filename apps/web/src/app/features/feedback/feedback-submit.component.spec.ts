import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackApi } from '../../core/feedback/feedback.api';
import { FeedbackSubmitComponent } from './feedback-submit.component';

const ID = '11111111-1111-4111-8111-111111111111';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(opts: { create?: ReturnType<typeof vi.fn> } = {}) {
  const create = opts.create ?? vi.fn().mockResolvedValue({ id: ID });
  return {
    create,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: FeedbackApi, useValue: { create } },
    ],
  };
}

function espionnerNavigation(): ReturnType<typeof vi.fn> {
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  return navigate;
}

/** Remplit le formulaire avec un retour valide. */
async function remplir(): Promise<void> {
  await userEvent.type(
    screen.getByRole('textbox', { name: /Titre/ }),
    'Le score ne se recalcule pas',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Description/ }),
    'Après avoir changé la pondération, le score reste celui d’avant.',
  );
}

afterEach(() => vi.restoreAllMocks());

describe('FeedbackSubmitComponent', () => {
  it('n’affiche AUCUN reproche sur un formulaire vierge', async () => {
    // Signaler « titre trop court » sur un champ jamais touché est une alarme
    // permanente et inutile.
    await render(FeedbackSubmitComponent, { providers: setup().providers });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('GARDE l’envoi inactif tant que le retour est incomplet', async () => {
    await render(FeedbackSubmitComponent, { providers: setup().providers });

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Envoyer/ }).disabled).toBe(true);
  });

  it('AVERTIT avant l’appel réseau quand le titre est trop court', async () => {
    const t = setup();
    await render(FeedbackSubmitComponent, { providers: t.providers });

    await userEvent.type(screen.getByRole('textbox', { name: /Titre/ }), 'bug');
    await userEvent.type(screen.getByRole('textbox', { name: /Description/ }), 'Un corps correct.');

    expect(await screen.findByText(/^Titre /)).toBeTruthy();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('dépose le retour, puis mène à la liste en l’ouvrant', async () => {
    // L'auteur voit ce qui a été enregistré, et peut en suivre le traitement.
    const t = setup();
    await render(FeedbackSubmitComponent, { providers: t.providers });
    const navigate = espionnerNavigation();

    await remplir();
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }));
    await tick();

    expect(t.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', severity: 'majeur' }),
    );
    expect(navigate).toHaveBeenCalledWith(['/retours'], { queryParams: { ouvert: ID } });
  });

  it('JOINT l’écran d’où l’on vient, sans le redemander', async () => {
    const t = setup();
    await render(FeedbackSubmitComponent, {
      providers: t.providers,
      inputs: { depuis: '/profils/premium', gamme: 'premium' },
    });

    expect(await screen.findByText(/sera joint automatiquement/)).toBeTruthy();

    await remplir();
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }));
    await tick();

    expect(t.create).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { route: '/profils/premium', targetUrl: null, gamme: 'premium' },
      }),
    );
  });

  it('n’annonce AUCUN contexte quand il n’y en a pas', async () => {
    await render(FeedbackSubmitComponent, { providers: setup().providers });
    expect(screen.queryByText(/sera joint automatiquement/)).toBeNull();
  });

  it('n’attache PAS de contexte vide à la charge envoyée', async () => {
    const t = setup();
    await render(FeedbackSubmitComponent, { providers: t.providers });

    await remplir();
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }));
    await tick();

    expect(vi.mocked(t.create).mock.calls[0]?.[0]).not.toHaveProperty('context');
  });

  it('DIT que rien n’a été enregistré quand l’envoi échoue', async () => {
    // Laisser croire à un enregistrement ferait perdre le retour pour de bon.
    const create = vi.fn().mockRejectedValue(new Error('réseau'));
    await render(FeedbackSubmitComponent, { providers: setup({ create }).providers });

    await remplir();
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }));

    expect(await screen.findByText(/n’a pas été enregistré/)).toBeTruthy();
  });

  it('REPREND le message précis de l’API plutôt qu’un échec générique', async () => {
    const create = vi.fn().mockRejectedValue({ error: { message: 'Trop de retours déposés.' } });
    await render(FeedbackSubmitComponent, { providers: setup({ create }).providers });

    await remplir();
    await userEvent.click(screen.getByRole('button', { name: /Envoyer/ }));

    expect(await screen.findByText(/Trop de retours déposés/)).toBeTruthy();
  });

  it('annonce le budget de caractères restant', async () => {
    await render(FeedbackSubmitComponent, { providers: setup().providers });
    expect(await screen.findByText(/5000 caractères restants/)).toBeTruthy();

    await userEvent.type(screen.getByRole('textbox', { name: /Description/ }), 'douze cars');
    expect(await screen.findByText(/4990 caractères restants/)).toBeTruthy();
  });

  it('offre tous les types et toutes les gravités', async () => {
    await render(FeedbackSubmitComponent, { providers: setup().providers });

    const type = screen.getByRole<HTMLSelectElement>('combobox', { name: /Type/ });
    const gravite = screen.getByRole<HTMLSelectElement>('combobox', { name: /Gravité/ });
    expect(type.options).toHaveLength(3);
    expect(gravite.options).toHaveLength(4);
  });
});
