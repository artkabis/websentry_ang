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
          <h1 class="text-2xl font-semibold text-slate-900">Profils par gamme</h1>
          <p class="mt-1 text-sm text-slate-500">
            Chaque gamme porte ses propres règles d'analyse.
            <strong>default</strong> s'applique quand aucune gamme n'est détectée.
          </p>
        </div>
        @if (auth.isAdmin()) {
          <button
            type="button"
            (click)="createProfile()"
            class="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Nouveau profil
          </button>
        }
      </header>

      @if (error(); as message) {
        <p role="alert" class="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ message }}
        </p>
      }

      @if (loading()) {
        <p class="mt-6 text-sm text-slate-500" role="status">Chargement des profils…</p>
      } @else if (profiles().length === 0) {
        <p class="mt-6 text-sm text-slate-500">Aucun profil enregistré.</p>
      } @else {
        <ul
          class="mt-6 divide-y divide-slate-200 rounded-xl bg-white shadow-sm ring-1 ring-slate-200"
        >
          @for (profile of profiles(); track profile.profile) {
            <li class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <a
                  [routerLink]="['/profils', profile.profile]"
                  class="text-sm font-medium text-brand-700 hover:underline"
                >
                  {{ profile.label }}
                </a>
                <p class="truncate text-xs text-slate-500">
                  <code>{{ profile.profile }}</code>
                  · version {{ profile.version }} · modifié le
                  {{ profile.updatedAt | date: 'dd/MM/yyyy HH:mm' }}
                  @if (profile.updatedBy) {
                    par {{ profile.updatedBy }}
                  }
                </p>
                @if (profile.description) {
                  <p class="mt-0.5 truncate text-xs text-slate-400">{{ profile.description }}</p>
                }
              </div>

              @if (profile.profile === 'default') {
                <!-- Le repli universel n'est pas supprimable : sans lui, une
                     gamme non détectée n'aurait plus aucun réglage. -->
                <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
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
      this.error.set('Chargement des profils impossible — réessayez');
    } finally {
      this.loading.set(false);
    }
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
