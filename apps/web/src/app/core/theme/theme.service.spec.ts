import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

/** Instancie le service APRÈS avoir préparé le stockage — il lit au constructeur. */
function service(): ThemeService {
  TestBed.resetTestingModule();
  return TestBed.inject(ThemeService);
}

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('s’en remet au système quand rien n’a été choisi', () => {
    const theme = service();

    expect(theme.preference()).toBe('systeme');
    // Pas d'attribut : c'est `color-scheme: light dark` qui tranche, sans que
    // le JavaScript ait à lire la préférence du système.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('pose le thème choisi sur la racine du document', () => {
    const theme = service();

    theme.set('sombre');

    expect(document.documentElement.getAttribute('data-theme')).toBe('sombre');
    expect(theme.preference()).toBe('sombre');
  });

  it('RETROUVE le choix précédent au démarrage suivant', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sombre');

    const theme = service();

    expect(theme.preference()).toBe('sombre');
    expect(document.documentElement.getAttribute('data-theme')).toBe('sombre');
  });

  it('EFFACE le choix quand on revient au système', () => {
    const theme = service();
    theme.set('sombre');

    theme.set('systeme');

    // Conserver « systeme » en stockage reviendrait à figer une valeur qui
    // signifie précisément « ne rien figer ».
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('IGNORE une valeur stockée qu’il ne connaît pas', () => {
    // Clé écrite à la main, ou par une version antérieure : un `data-theme`
    // inconnu ne serait servi par aucune règle, et l'écran resterait clair
    // sans que l'interface sache expliquer pourquoi.
    localStorage.setItem(THEME_STORAGE_KEY, 'contraste-eleve');

    const theme = service();

    expect(theme.preference()).toBe('systeme');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  describe('stockage refusé', () => {
    // Navigation privée, cookies bloqués, quota atteint : l'accès lève. Le
    // thème doit valoir pour la session en cours plutôt que de faire tomber
    // l'écran — perdre une préférence est moins grave que perdre l'écran.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('bascule quand même quand l’écriture lève', () => {
      const theme = service();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('accès refusé');
      });

      expect(() => theme.set('sombre')).not.toThrow();
      expect(document.documentElement.getAttribute('data-theme')).toBe('sombre');
    });

    it('démarre sur le thème système quand la lecture lève', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('accès refusé');
      });

      const theme = service();

      expect(theme.preference()).toBe('systeme');
    });

    it('n’échoue pas non plus sur l’effacement', () => {
      const theme = service();
      theme.set('sombre');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('accès refusé');
      });

      expect(() => theme.set('systeme')).not.toThrow();
      expect(theme.preference()).toBe('systeme');
    });
  });

  it('fait défiler les trois préférences dans l’ordre', () => {
    const theme = service();

    theme.set('clair');
    theme.next();
    expect(theme.preference()).toBe('sombre');
    theme.next();
    expect(theme.preference()).toBe('systeme');
    theme.next();
    expect(theme.preference()).toBe('clair');
  });
});
