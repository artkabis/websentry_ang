import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import type { DocBlock } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import { DocBlocsComponent, slugInterne } from './doc-contenu.component';

const providers = [provideZonelessChangeDetection(), provideRouter([])];

const rendre = (blocs: DocBlock[]) => render(DocBlocsComponent, { providers, inputs: { blocs } });

describe('slugInterne', () => {
  it('reconnaît un lien interne', () => {
    expect(slugInterne('doc:premiers-pas')).toBe('premiers-pas');
  });

  it('ne reconnaît PAS une adresse externe', () => {
    expect(slugInterne('https://exemple.test/page')).toBeNull();
  });
});

describe('DocBlocsComponent', () => {
  it('rend un titre avec son ancre, pour les liens profonds', async () => {
    await rendre([{ type: 'titre', niveau: 2, texte: 'Avant tout', ancre: 'avant-tout' }]);

    const titre = screen.getByRole('heading', { level: 2, name: 'Avant tout' });
    expect(titre.id).toBe('avant-tout');
  });

  it('distingue le niveau 3 du niveau 2', async () => {
    await rendre([{ type: 'titre', niveau: 3, texte: 'Détail', ancre: 'detail' }]);

    expect(screen.getByRole('heading', { level: 3, name: 'Détail' })).toBeTruthy();
  });

  it('rend une liste ordonnée et une liste à puces avec les bons rôles', async () => {
    const { container } = await rendre([
      { type: 'liste', ordonnee: true, elements: [[{ type: 'texte', texte: 'un' }]] },
      { type: 'liste', ordonnee: false, elements: [[{ type: 'texte', texte: 'deux' }]] },
    ]);

    expect(container.querySelector('ol')).toBeTruthy();
    expect(container.querySelector('ul')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('NOMME le ton d’un encadré, au lieu de le confier à la seule couleur', async () => {
    await rendre([
      { type: 'note', ton: 'avertissement', contenu: [{ type: 'texte', texte: 'Danger.' }] },
    ]);

    // Un fond jaune ne s'entend pas : le mot doit être là.
    expect(screen.getByText('Attention')).toBeTruthy();
  });

  it('dit « Note » pour le ton informatif', async () => {
    await rendre([
      { type: 'note', ton: 'info', contenu: [{ type: 'texte', texte: 'Sachez-le.' }] },
    ]);

    expect(screen.getByText('Note')).toBeTruthy();
  });

  it('rend un bloc de code FOCUSABLE, car il peut déborder', async () => {
    // Une zone qui défile horizontalement et qu'on ne peut pas atteindre au
    // clavier est inatteignable pour qui n'a pas de souris (WCAG 2.1.1).
    const { container } = await rendre([{ type: 'code', langage: 'bash', texte: 'pnpm install' }]);

    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('tabindex')).toBe('0');
    expect(pre?.textContent).toContain('pnpm install');
  });

  it('mène un lien interne vers la page visée du portail', async () => {
    await rendre([
      {
        type: 'paragraphe',
        contenu: [{ type: 'lien', texte: 'les profils', href: 'doc:profils' }],
      },
    ]);

    expect(screen.getByRole('link', { name: 'les profils' }).getAttribute('href')).toBe(
      '/aide/profils',
    );
  });

  it('OUVRE un lien externe dans un onglet neuf, sans donner la main à l’ouvreur', async () => {
    await rendre([
      {
        type: 'paragraphe',
        contenu: [{ type: 'lien', texte: 'la norme', href: 'https://www.w3.org/TR/WCAG22/' }],
      },
    ]);

    const lien = screen.getByRole('link', { name: /la norme/ });
    expect(lien.getAttribute('href')).toBe('https://www.w3.org/TR/WCAG22/');
    expect(lien.getAttribute('target')).toBe('_blank');
    expect(lien.getAttribute('rel')).toContain('noopener');
  });

  it('ANNONCE qu’un lien externe change d’onglet', async () => {
    // La flèche est décorative ; sans le texte masqué, rien ne prévient.
    await rendre([
      {
        type: 'paragraphe',
        contenu: [{ type: 'lien', texte: 'la norme', href: 'https://www.w3.org/TR/WCAG22/' }],
      },
    ]);

    expect(screen.getByRole('link', { name: /nouvel onglet/ })).toBeTruthy();
  });

  it('N’INTERPRÈTE JAMAIS le texte comme du balisage', async () => {
    // Le cœur du module : un bloc est une donnée, jamais du HTML. Le texte
    // passe par l'interpolation, qui l'échappe — il n'y a rien à désinfecter.
    const { container } = await rendre([
      {
        type: 'paragraphe',
        contenu: [
          { type: 'texte', texte: '<script>alert(1)</script>' },
          { type: 'fort', texte: '<img src=x onerror=alert(1)>' },
          { type: 'code', texte: '<b>gras ?</b>' },
        ],
      },
    ]);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('met en valeur un fragment fort et un fragment de code', async () => {
    const { container } = await rendre([
      {
        type: 'paragraphe',
        contenu: [
          { type: 'fort', texte: 'important' },
          { type: 'code', texte: 'pnpm test' },
        ],
      },
    ]);

    expect(container.querySelector('strong')?.textContent?.trim()).toBe('important');
    expect(container.querySelector('code')?.textContent?.trim()).toBe('pnpm test');
  });
});
