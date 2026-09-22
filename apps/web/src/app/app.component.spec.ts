import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { AuthService } from './core/auth/auth.service';

function providers(
  loading: boolean,
  user: unknown = null,
  opts: { permissions?: string[]; superAdmin?: boolean } = {},
) {
  return [
    provideZonelessChangeDetection(),
    provideRouter([]),
    {
      provide: AuthService,
      useValue: {
        loading: () => loading,
        user: () => user,
        hasPermission: (code: string) => (opts.permissions ?? []).includes(code),
        isSuperAdmin: () => opts.superAdmin ?? false,
      },
    },
  ];
}

/** Un utilisateur quelconque — la coquille n'en lit que la présence. */
const CONNECTE = { username: 'alice' };

describe('AppComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('retient l’affichage tant que la session n’est pas résolue', async () => {
    // Sans ce garde-fou, un utilisateur déjà connecté verrait l'écran de
    // connexion clignoter avant d'être redirigé.
    await render(AppComponent, { providers: providers(true) });
    expect(screen.getByRole('status').textContent).toContain('Chargement');
  });

  it('rend la route une fois la session résolue', async () => {
    await render(AppComponent, { providers: providers(false) });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('OFFRE le choix d’apparence sur tous les écrans, connecté ou non', async () => {
    // Le réglage doit exister avant la connexion : c'est justement l'écran
    // qu'un utilisateur voit le plus souvent en premier, et le soir.
    await render(AppComponent, { providers: providers(false) });

    expect(screen.getByRole('radio', { name: 'Sombre' })).toBeTruthy();
  });

  it('ne propose pas le retour au tableau de bord à un visiteur', async () => {
    await render(AppComponent, { providers: providers(false) });

    expect(screen.queryByRole('link', { name: 'WebSentry' })).toBeNull();
  });

  it('ramène au tableau de bord depuis n’importe quel écran, une fois connecté', async () => {
    await render(AppComponent, { providers: providers(false, CONNECTE) });

    const lien = screen.getByRole('link', { name: 'WebSentry' });
    expect(lien.getAttribute('href')).toBe('/tableau-de-bord');
  });

  describe('navigation principale', () => {
    it('n’apparaît PAS pour un visiteur non connecté', async () => {
      await render(AppComponent, { providers: providers(false) });
      expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).toBeNull();
    });

    it('offre les familles d’écrans ouvertes à tous', async () => {
      await render(AppComponent, { providers: providers(false, CONNECTE) });
      const nav = screen.getByRole('navigation', { name: 'Navigation principale' });

      expect(
        within(nav)
          .getAllByRole('link')
          .map(a => a.textContent?.trim()),
        // « Retours » y figure : signaler ne demande aucune permission.
      ).toEqual(['Tableau de bord', 'Analyse', 'Historique', 'Profils', 'Retours']);
    });

    it('ajoute « Comptes » à qui détient users:read', async () => {
      await render(AppComponent, {
        providers: providers(false, CONNECTE, { permissions: ['users:read'] }),
      });
      const nav = screen.getByRole('navigation', { name: 'Navigation principale' });

      expect(within(nav).getByRole('link', { name: 'Comptes' })).toBeTruthy();
      // Le journal est réservé au rang 100 : proposer le lien mènerait à un
      // écran d'accès refusé, ce qui est pire que de ne rien proposer.
      expect(within(nav).queryByRole('link', { name: 'Journal' })).toBeNull();
    });

    it('ajoute « Journal » au seul super administrateur', async () => {
      await render(AppComponent, {
        providers: providers(false, CONNECTE, { permissions: ['users:read'], superAdmin: true }),
      });
      const nav = screen.getByRole('navigation', { name: 'Navigation principale' });

      expect(within(nav).getByRole('link', { name: 'Journal' })).toBeTruthy();
    });

    it('REFERME le menu dès qu’on suit un lien', async () => {
      // Le laisser ouvert masquerait l'écran qu'on vient d'ouvrir.
      await render(AppComponent, { providers: providers(false, CONNECTE) });

      const menu = screen.getByRole('button', { name: 'Menu' });
      await userEvent.click(menu);
      expect(menu.getAttribute('aria-expanded')).toBe('true');

      await userEvent.click(screen.getByRole('link', { name: 'Analyse' }));
      expect(menu.getAttribute('aria-expanded')).toBe('false');
    });

    it('se replie derrière un bouton dont l’état est ANNONCÉ', async () => {
      // `aria-expanded` est ce qui dit à un lecteur d'écran si le menu est
      // ouvert : la classe CSS ne lui apprend rien.
      await render(AppComponent, { providers: providers(false, CONNECTE) });

      const menu = screen.getByRole('button', { name: 'Menu' });
      expect(menu.getAttribute('aria-expanded')).toBe('false');

      await userEvent.click(menu);
      expect(menu.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('lien d’évitement', () => {
    it('existe, et porte le contenu comme cible', async () => {
      await render(AppComponent, { providers: providers(false, CONNECTE) });

      const evitement = screen.getByRole('link', { name: 'Aller au contenu' });
      expect(evitement.getAttribute('href')).toBe('#contenu');
    });

    it('déplace le focus SANS quitter la route', async () => {
      // Avec une base de document à la racine, une ancre de fragment est
      // résolue en URL absolue : le routeur ramènerait à l'accueil.
      const { fixture } = await render(AppComponent, {
        providers: providers(false, CONNECTE),
      });

      await userEvent.click(screen.getByRole('link', { name: 'Aller au contenu' }));
      const cible = fixture.nativeElement.querySelector('#contenu') as HTMLElement;
      expect(document.activeElement).toBe(cible);
    });
  });

  describe('signalement depuis n’importe quel écran', () => {
    it('offre le lien à un compte connecté', async () => {
      // Si signaler coûte plus cher que contourner, personne ne signale.
      await render(AppComponent, { providers: providers(false, CONNECTE) });

      const lien = screen.getByRole('link', { name: 'Signaler' });
      expect(lien.getAttribute('href')).toContain('/retours/nouveau');
    });

    it('ne l’offre PAS à un visiteur non connecté', async () => {
      await render(AppComponent, { providers: providers(false) });
      expect(screen.queryByRole('link', { name: 'Signaler' })).toBeNull();
    });
  });
});
