import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { ProfileMeta } from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { ProfilesApi } from '../../core/profiles/profiles.api';

/**
 * Liste des profils par gamme.
 *
 * Accessible à tout compte authentifié — un testeur doit pouvoir consulter les
 * règles appliquées à ses scans. Les actions d'écriture ne sont proposées qu'aux
 * administrateurs, en miroir de ce que l'API autorise.
 */
@Component({
  selector: 'ws-profiles-list',
  standalone: true,
  imports: [RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-4xl px-4 py-10">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">Profils par gamme</h1>
          <p class="mt-1 text-sm text-content-subtle">
            Chaque gamme porte ses propres règles d'analyse.
            <strong>default</strong> s'applique quand aucune gamme n'est détectée.
          </p>
        </div>
        @if (auth.isAdmin()) {
          <button
            type="button"
            (click)="createProfile()"
            class="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent hover:bg-brand-strong"
          >
            Nouveau profil
          </button>
        }
      </header>

      <!--
        Les quatre états s'excluent. Montrer « Aucun profil enregistré » sous un
        message d'échec affirmait deux choses contradictoires : que la liste est
        vide, et qu'on n'a pas pu la lire. Une liste qu'on n'a pas lue n'est pas
        vide — elle est inconnue.
      -->
      @if (loading()) {
        <p class="mt-6 text-sm text-content-subtle" role="status">Chargement des profils…</p>
      } @else if (error(); as message) {
        <div
          role="alert"
          class="mt-6 rounded-lg bg-danger-surface px-4 py-3 text-sm text-danger-content"
        >
          <p>{{ message }}</p>
          <button
            type="button"
            (click)="reload()"
            class="mt-2 rounded-lg border border-danger-content px-3 py-1.5 text-xs font-medium
                   hover:bg-panel"
          >
            Réessayer
          </button>
        </div>
      } @else if (profiles().length === 0) {
        <div class="mt-6 rounded-xl bg-panel p-6 text-center shadow-sm ring-1 ring-line">
          <p class="text-sm text-content-muted">Aucun profil enregistré.</p>
          <p class="mt-1 text-xs text-content-subtle">
            Un profil porte les règles d'analyse d'une gamme de sites.
            @if (auth.isAdmin()) {
              Créez-en un pour commencer.
            } @else {
              Un administrateur peut en créer.
            }
          </p>
        </div>
      } @else {
        <ul class="mt-6 divide-y divide-line rounded-xl bg-panel shadow-sm ring-1 ring-line">
          @for (profile of profiles(); track profile.profile) {
            <li class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <a
                  [routerLink]="['/profils', profile.profile]"
                  class="text-sm font-medium text-brand-text hover:underline"
                >
                  {{ profile.label }}
                </a>
                <p class="truncate text-xs text-content-subtle">
                  <code>{{ profile.profile }}</code>
                  · version {{ profile.version }} · modifié le
                  {{ profile.updatedAt | date: 'dd/MM/yyyy HH:mm' }}
                  @if (profile.updatedBy) {
                    par {{ profile.updatedBy }}
                  }
                </p>
                @if (profile.description) {
                  <p class="mt-0.5 truncate text-xs text-content-subtle">
                    {{ profile.description }}
                  </p>
                }
              </div>

              @if (profile.profile === 'default') {
                <!-- Le repli universel n'est pas supprimable : sans lui, une
                     gamme non détectée n'aurait plus aucun réglage. -->
                <span
                  class="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs text-content-subtle"
                >
                  Repli
                </span>
              }
            </li>
          }
        </ul>
      }
    </main>
  `,
})
export class ProfilesListComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ProfilesApi);
  private readonly router = inject(Router);

  readonly profiles = signal<ProfileMeta[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.profiles.set(await this.api.list());
    } catch {
      this.error.set('Chargement des profils impossible.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Relance la lecture après un échec — le bouton de reprise du bloc d'erreur. */
  async reload(): Promise<void> {
    await this.load();
  }

  /**
   * Ouvre l'éditeur sur une gamme neuve.
   *
   * La saisie est normalisée côté serveur ; on filtre tout de même ici pour que
   * l'URL reste lisible et que l'utilisateur voie immédiatement ce qui sera retenu.
   */
  async createProfile(): Promise<void> {
    const saisie = globalThis.prompt('Nom de la gamme (minuscules, chiffres et tirets)');
    if (!saisie) return;

    const gamme = saisie
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 50);

    if (gamme.length === 0) {
      this.error.set('Nom de gamme invalide — au moins un caractère alphanumérique est requis');
      return;
    }
    await this.router.navigate(['/profils', gamme]);
  }
}
