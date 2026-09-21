import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

/**
 * Préférence d'apparence de l'utilisateur.
 *
 * `systeme` n'est pas une troisième couleur : c'est l'absence de choix, donc
 * la décision rendue au système d'exploitation. La distinguer de « clair » est
 * ce qui permet à une machine réglée en sombre le soir de suivre son réglage
 * sans qu'on la rebascule à la main.
 */
export type ThemePreference = 'clair' | 'sombre' | 'systeme';

const PREFERENCES: readonly ThemePreference[] = ['clair', 'sombre', 'systeme'];

/** Clé de stockage — préfixée, l'origine étant partagée avec d'autres outils. */
export const THEME_STORAGE_KEY = 'websentry.theme';

/**
 * Apparence de l'application.
 *
 * Le service ne peint rien : il pose `data-theme` sur la racine du document, et
 * la feuille de style en tire les conséquences par `color-scheme` et
 * `light-dark()`. Séparer ainsi évite qu'un composant ait à connaître une
 * couleur — et permet au thème système de s'appliquer AVANT que le JavaScript
 * ne démarre, sans écran clair qui clignote.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly _preference = signal<ThemePreference>('systeme');

  /** Préférence exprimée : ce que l'utilisateur a choisi, pas ce qui est peint. */
  readonly preference = this._preference.asReadonly();

  constructor() {
    this.apply(this.restore());
  }

  /** Applique et conserve une préférence. */
  set(preference: ThemePreference): void {
    this.apply(preference);
    try {
      if (preference === 'systeme') {
        this.document.defaultView?.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
    } catch {
      // Stockage refusé (navigation privée, cookies bloqués) : le thème vaut
      // pour la session en cours. Perdre la préférence est préférable à un
      // écran qui refuse de basculer.
    }
  }

  /** Passe à la préférence suivante — clair, sombre, système, et ainsi de suite. */
  next(): void {
    const index = PREFERENCES.indexOf(this._preference());
    this.set(PREFERENCES[(index + 1) % PREFERENCES.length] ?? 'systeme');
  }

  private apply(preference: ThemePreference): void {
    this._preference.set(preference);
    const root = this.document.documentElement;
    // Pas d'attribut pour « système » : la feuille de style laisse alors
    // `color-scheme: light dark` décider, sans rien à recalculer ici.
    if (preference === 'systeme') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
  }

  private restore(): ThemePreference {
    try {
      const stored = this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
      // Une valeur inconnue — clé écrite par une ancienne version, ou à la
      // main — ne doit pas produire un `data-theme` que la feuille ignore.
      return stored === 'clair' || stored === 'sombre' ? stored : 'systeme';
    } catch {
      return 'systeme';
    }
  }
}
