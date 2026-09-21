import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { SitemapParseResponse } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisApi } from '../../core/analysis/analysis.api';
import { SitemapComponent } from './sitemap.component';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function parsed(over: Partial<SitemapParseResponse> = {}): SitemapParseResponse {
  return {
    sitemapUrl: 'https://exemple.fr/sitemap.xml',
    discovered: 2,
    entries: [
      { url: 'https://exemple.fr/', lastmod: '2026-06-01', priority: 1 },
      { url: 'https://exemple.fr/contact', lastmod: null, priority: null },
    ],
    truncated: false,
    ...over,
  };
}

function setup(
  opts: {
    detectSitemap?: ReturnType<typeof vi.fn>;
    parseSitemap?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const detectSitemap =
    opts.detectSitemap ?? vi.fn().mockResolvedValue('https://exemple.fr/sitemap.xml');
  const parseSitemap = opts.parseSitemap ?? vi.fn().mockResolvedValue(parsed());

  return {
    detectSitemap,
    parseSitemap,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AnalysisApi, useValue: { detectSitemap, parseSitemap } },
    ],
  };
}

async function lire(t: ReturnType<typeof setup>, url = 'https://exemple.fr/') {
  await render(SitemapComponent, { providers: t.providers });
  await userEvent.type(screen.getByRole('textbox'), url);
  await userEvent.click(screen.getByRole('button', { name: 'Lire le sitemap' }));
  await tick();
  await tick();
}

afterEach(() => vi.restoreAllMocks());

describe('SitemapComponent', () => {
  describe('lecture', () => {
    it('CHERCHE le sitemap quand on lui donne l’adresse du site', async () => {
      // Demander à l'utilisateur de distinguer site et sitemap serait lui faire
      // faire le travail que l'API sait déjà faire.
      const t = setup();
      await lire(t, 'https://exemple.fr/');

      expect(t.detectSitemap).toHaveBeenCalledWith('https://exemple.fr/');
      expect(t.parseSitemap).toHaveBeenCalledWith('https://exemple.fr/sitemap.xml', 50, false);
    });

    it('LIT directement une adresse de sitemap, sans la chercher', async () => {
      const t = setup();
      await lire(t, 'https://exemple.fr/sitemap.xml');

      expect(t.detectSitemap).not.toHaveBeenCalled();
      expect(t.parseSitemap).toHaveBeenCalledWith('https://exemple.fr/sitemap.xml', 50, false);
    });

    it('retombe sur l’adresse saisie quand aucun sitemap n’est trouvé', async () => {
      // Mieux vaut tenter la lecture que refuser d'emblée : l'adresse donnée
      // est peut-être un sitemap sans extension.
      const t = setup({ detectSitemap: vi.fn().mockResolvedValue(null) });
      await lire(t, 'https://exemple.fr/plan');

      expect(t.parseSitemap).toHaveBeenCalledWith('https://exemple.fr/plan', 50, false);
    });

    it('transmet le filtre de PRIORITÉ à l’API', async () => {
      // Le filtre est écrit côté serveur : l'ignorer priverait l'interface d'un
      // tri déjà disponible.
      const t = setup();
      await render(SitemapComponent, { providers: t.providers });
      await userEvent.type(screen.getByRole('textbox'), 'https://exemple.fr/sitemap.xml');
      await userEvent.click(screen.getByRole('checkbox', { name: /priorité déclarée/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Lire le sitemap' }));
      await tick();

      expect(t.parseSitemap).toHaveBeenCalledWith('https://exemple.fr/sitemap.xml', 50, true);
    });

    it('BORNE le plafond aux limites du contrat', async () => {
      // L'API refuse au-delà : envoyer une valeur hors bornes échangerait un
      // réglage discutable contre une erreur.
      const t = setup();
      await render(SitemapComponent, { providers: t.providers });
      await userEvent.type(screen.getByRole('textbox'), 'https://exemple.fr/sitemap.xml');
      const plafond = screen.getByRole<HTMLInputElement>('spinbutton');
      plafond.value = '5000';
      plafond.dispatchEvent(new Event('input'));
      await userEvent.click(screen.getByRole('button', { name: 'Lire le sitemap' }));
      await tick();

      expect(t.parseSitemap).toHaveBeenCalledWith('https://exemple.fr/sitemap.xml', 200, false);
    });

    it('PRÉVIENT quand le plafond a écarté des pages', async () => {
      const t = setup({
        parseSitemap: vi.fn().mockResolvedValue(parsed({ discovered: 900, truncated: true })),
      });
      await lire(t);

      expect(screen.getByText(/900 page\(s\) découverte\(s\)/)).toBeTruthy();
    });

    it('propose une SUITE quand le sitemap ne donne rien', async () => {
      const t = setup({
        parseSitemap: vi.fn().mockResolvedValue(parsed({ entries: [], discovered: 0 })),
      });
      await lire(t);

      expect(screen.getByRole('link', { name: /Analyser une page précise/ })).toBeTruthy();
    });

    it('permet de REPRENDRE après un échec', async () => {
      const t = setup({
        parseSitemap: vi
          .fn()
          .mockRejectedValueOnce(new Error('Sitemap illisible'))
          .mockResolvedValue(parsed()),
      });
      await lire(t);

      expect(screen.getByRole('alert').textContent).toContain('Sitemap illisible');
      await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
      await tick();

      expect(screen.getByText('https://exemple.fr/contact')).toBeTruthy();
    });
  });

  describe('sélection', () => {
    it('SÉLECTIONNE tout d’emblée', async () => {
      // On vient lire un sitemap pour analyser ses pages, pas pour les cocher
      // une à une.
      const t = setup();
      await lire(t);

      // Les deux pages listées, cochées ; l'option de priorité, elle, reste
      // décochée — c'est un réglage de lecture, pas une page.
      const cases = screen
        .getAllByRole<HTMLInputElement>('checkbox')
        .filter(box => box.id.startsWith('url-'));

      expect(cases).toHaveLength(2);
      expect(cases.every(box => box.checked)).toBe(true);
      expect(screen.getByText(/2 page\(s\) sur 2 sélectionnée\(s\)/)).toBeTruthy();
    });

    it('retire une page d’un clic', async () => {
      const t = setup();
      await lire(t);

      await userEvent.click(screen.getByRole('checkbox', { name: /contact/ }));

      expect(screen.getByText(/1 page\(s\) sur 2 sélectionnée\(s\)/)).toBeTruthy();
    });

    it('bascule tout, dans les deux sens', async () => {
      const t = setup();
      await lire(t);

      await userEvent.click(screen.getByRole('button', { name: 'Tout désélectionner' }));
      expect(screen.getByText('Aucune page sélectionnée.')).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Tout sélectionner' }));
      expect(screen.getByText(/2 page\(s\) sur 2/)).toBeTruthy();
    });

    it('n’envoie RIEN quand la sélection est vide', async () => {
      const t = setup();
      await lire(t);
      await userEvent.click(screen.getByRole('button', { name: 'Tout désélectionner' }));

      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Analyser la sélection' }).disabled,
      ).toBe(true);
    });
  });

  it('VERSE la sélection à l’écran de lot, par l’état de navigation', async () => {
    // Deux cents URL ne tiennent pas dans une barre d'adresse : les y mettre
    // produirait un lien intransmissible.
    const t = setup();
    await render(SitemapComponent, { providers: t.providers });
    const router = (await import('@angular/core/testing')).TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.type(screen.getByRole('textbox'), 'https://exemple.fr/sitemap.xml');
    await userEvent.click(screen.getByRole('button', { name: 'Lire le sitemap' }));
    await tick();
    await userEvent.click(screen.getByRole('checkbox', { name: /contact/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Analyser la sélection' }));

    expect(navigate).toHaveBeenCalledWith(['/analyse/lot'], {
      state: { urls: ['https://exemple.fr/'] },
    });
  });
});
