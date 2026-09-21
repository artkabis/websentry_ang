import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  DEFAULT_PROFILE,
  defaultAnalysisSettings,
  type AnalysisSettings,
  type CheckMeta,
  type SettingsProfile,
} from '@websentry/shared';
import { AuthService } from '../../core/auth/auth.service';
import { ProfileConflictError, ProfilesApi } from '../../core/profiles/profiles.api';
import {
  buildSettingsForm,
  patchFormFromSettings,
  rangeIssues,
  settingsFromForm,
  type RangeIssue,
} from './settings-form';

/**
 * Éditeur d'un profil par gamme.
 *
 * Trois points méritent attention :
 *
 *  • Le VERROUILLAGE OPTIMISTE : la version lue est renvoyée à l'enregistrement.
 *    Si quelqu'un a écrit entre-temps, l'API refuse (409) et l'on propose un
 *    rechargement plutôt que d'écraser silencieusement le travail d'autrui.
 *  • Les réglages NON ÉDITÉS ici (listes de mots, règles par page, pondérations)
 *    sont conservés et réinjectés : sans cela, ouvrir puis enregistrer un profil
 *    l'amputerait.
 *  • Les contrôles CROISÉS (intervalles) doublent ceux du schéma partagé, pour
 *    avertir avant l'appel réseau.
 */
@Component({
  selector: 'ws-profile-editor',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-3xl px-4 py-10">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-content">
            {{ profile()?.label ?? gamme() }}
          </h1>
          <p class="mt-1 text-sm text-content-subtle">
            <code>{{ gamme() }}</code>
            @if (profile(); as p) {
              · version {{ p.version }}
            } @else {
              · nouveau profil
            }
          </p>
        </div>
        <button
          type="button"
          (click)="back()"
          class="shrink-0 rounded-lg border border-field px-3 py-2 text-sm text-content-muted hover:bg-sunken"
        >
          Retour
        </button>
      </header>

      @if (loading()) {
        <p class="mt-8 text-sm text-content-subtle" role="status">Chargement…</p>
      } @else {
        @if (conflict(); as c) {
          <div
            role="alert"
            class="mt-6 rounded-lg bg-warn-surface px-4 py-3 text-sm text-warn-content"
          >
            <p class="font-medium">Ce profil a été modifié par quelqu'un d'autre</p>
            <p class="mt-1">
              Version en base : {{ c.currentVersion }} — la vôtre : {{ c.expectedVersion }}.
              Recharger remplacera vos modifications non enregistrées.
            </p>
            <button
              type="button"
              (click)="reload()"
              class="mt-2 rounded-lg bg-warn-solid px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-warn-solid-hover"
            >
              Recharger le profil
            </button>
          </div>
        }

        @if (message(); as m) {
          <p role="status" class="mt-6 rounded-lg bg-ok-surface px-3 py-2 text-sm text-ok-content">
            {{ m }}
          </p>
        }
        @if (error(); as e) {
          <p
            role="alert"
            class="mt-6 rounded-lg bg-danger-surface px-3 py-2 text-sm text-danger-content"
          >
            {{ e }}
          </p>
        }

        <form class="mt-8 space-y-8" [formGroup]="form" (ngSubmit)="save()" novalidate>
          <fieldset
            class="rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line"
            [disabled]="!canEdit()"
          >
            <legend class="px-1 text-sm font-medium text-content">Métadonnées</legend>
            <div class="mt-4 grid grid-cols-2 gap-4">
              @for (field of metaFields; track field.key) {
                <label class="block text-sm">
                  <span class="text-content-muted">{{ field.label }}</span>
                  <input
                    type="number"
                    [formControlName]="field.key"
                    [attr.aria-label]="field.label"
                    class="mt-1 w-full rounded-lg border border-field px-3 py-2 text-sm
                           focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30
                           disabled:bg-sunken"
                  />
                </label>
              }
            </div>
          </fieldset>

          <fieldset
            class="rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line"
            [disabled]="!canEdit()"
          >
            <legend class="px-1 text-sm font-medium text-content">Contenu et structure</legend>
            <div class="mt-4 grid grid-cols-2 gap-4">
              @for (field of contentFields; track field.key) {
                <label class="block text-sm">
                  <span class="text-content-muted">{{ field.label }}</span>
                  <input
                    type="number"
                    [formControlName]="field.key"
                    [attr.aria-label]="field.label"
                    class="mt-1 w-full rounded-lg border border-field px-3 py-2 text-sm
                           focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30
                           disabled:bg-sunken"
                  />
                </label>
              }
            </div>
            <label class="mt-4 flex items-center gap-2 text-sm text-content-muted">
              <input
                type="checkbox"
                formControlName="detectRegressions"
                class="rounded border-field"
              />
              Comparer chaque scan au précédent (détection de régressions)
            </label>
          </fieldset>

          <fieldset
            class="rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line"
            [disabled]="!canEdit()"
          >
            <legend class="px-1 text-sm font-medium text-content">
              Critères actifs ({{ enabledChecks().length }} / {{ checks().length }})
            </legend>
            <p class="mt-1 text-xs text-content-subtle">
              Un critère désactivé n'est ni analysé ni compté dans le score.
            </p>
            <div class="mt-4 grid grid-cols-2 gap-2">
              @for (check of checks(); track check.id) {
                <label class="flex items-start gap-2 text-sm text-content-muted">
                  <input
                    type="checkbox"
                    [checked]="isCheckEnabled(check.id)"
                    [disabled]="!canEdit()"
                    (change)="toggleCheck(check.id)"
                    [attr.aria-label]="check.title"
                    class="mt-0.5 rounded border-field"
                  />
                  <span>
                    {{ check.title }}
                    <span class="block text-xs text-content-subtle">{{ check.group }}</span>
                  </span>
                </label>
              }
            </div>
          </fieldset>

          @if (issues().length > 0) {
            <ul
              role="alert"
              class="space-y-1 rounded-lg bg-danger-surface px-4 py-3 text-sm text-danger-content"
            >
              @for (issue of issues(); track issue.field) {
                <li>{{ issue.message }}</li>
              }
            </ul>
          }

          @if (canEdit()) {
            <div class="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                [disabled]="saving() || issues().length > 0"
                class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-accent
                       hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
              <button
                type="button"
                (click)="resetToDefaults()"
                [disabled]="saving()"
                class="rounded-lg border border-field px-4 py-2 text-sm text-content-muted hover:bg-sunken"
              >
                Réinitialiser
              </button>
              <button
                type="button"
                (click)="exportProfile()"
                class="rounded-lg border border-field px-4 py-2 text-sm text-content-muted hover:bg-sunken"
              >
                Exporter
              </button>
              @if (gamme() !== defaultProfile) {
                <button
                  type="button"
                  (click)="remove()"
                  [disabled]="saving()"
                  class="ml-auto rounded-lg border border-danger-content px-4 py-2 text-sm text-danger-content hover:bg-danger-surface"
                >
                  Supprimer
                </button>
              }
            </div>
          } @else {
            <p class="text-sm text-content-subtle">
              Consultation seule — l'édition des profils est réservée aux administrateurs.
            </p>
          }
        </form>
      }
    </main>
  `,
})
export class ProfileEditorComponent {
  /** Gamme éditée, liée depuis le paramètre de route. */
  readonly gamme = input.required<string>();

  readonly auth = inject(AuthService);
  private readonly api = inject(ProfilesApi);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  readonly defaultProfile = DEFAULT_PROFILE;
  readonly form = buildSettingsForm(this.fb);

  readonly profile = signal<SettingsProfile | null>(null);
  readonly checks = signal<CheckMeta[]>([]);
  readonly enabledChecks = signal<string[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly conflict = signal<ProfileConflictError | null>(null);

  readonly canEdit = computed(() => this.auth.isAdmin());
  readonly issues = signal<RangeIssue[]>([]);

  /** Réglages non édités par le formulaire, conservés tels quels. */
  private baseSettings: AnalysisSettings = defaultAnalysisSettings();

  readonly metaFields = [
    { key: 'metaTitleMin' as const, label: 'Titre — minimum' },
    { key: 'metaTitleMax' as const, label: 'Titre — maximum' },
    { key: 'metaDescriptionMin' as const, label: 'Description — minimum' },
    { key: 'metaDescriptionMax' as const, label: 'Description — maximum' },
    { key: 'hnMinLength' as const, label: 'Titres Hn — minimum' },
    { key: 'hnMaxLength' as const, label: 'Titres Hn — maximum' },
  ];

  readonly contentFields = [
    { key: 'contentMinWords' as const, label: 'Mots — minimum' },
    { key: 'contentWarningWords' as const, label: 'Mots — seuil d’avertissement' },
    { key: 'boldMin' as const, label: 'Gras — minimum' },
    { key: 'boldMax' as const, label: 'Gras — maximum' },
    { key: 'imagesMaxSizeBytes' as const, label: 'Image — poids maximal (octets)' },
    {
      key: 'imagesWarningThresholdBytes' as const,
      label: 'Image — seuil d’avertissement (octets)',
    },
    { key: 'linksTimeout' as const, label: 'Liens — délai (ms)' },
  ];

  constructor() {
    // Le formulaire recalcule ses incohérences à chaque frappe : l'utilisateur
    // est averti avant de soumettre, pas après un aller-retour réseau.
    this.form.valueChanges.subscribe(() => this.issues.set(rangeIssues(this.form)));
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const registry = await this.api.registry();
      this.checks.set([...registry.checks]);

      try {
        const profile = await this.api.get(this.gamme());
        this.applyProfile(profile);
      } catch {
        // Gamme encore inexistante : on ouvre l'éditeur sur les valeurs par
        // défaut plutôt que d'afficher une erreur, puisque enregistrer la créera.
        this.profile.set(null);
        this.baseSettings = defaultAnalysisSettings();
        patchFormFromSettings(this.form, this.baseSettings);
        this.enabledChecks.set(this.checks().map(c => c.id));
      }
    } catch {
      this.error.set('Chargement impossible — réessayez');
    } finally {
      this.issues.set(rangeIssues(this.form));
      this.loading.set(false);
    }
  }

  private applyProfile(profile: SettingsProfile): void {
    this.profile.set(profile);
    this.baseSettings = profile.settings;
    patchFormFromSettings(this.form, profile.settings);
    this.enabledChecks.set([...(profile.settings.enabledChecks ?? this.checks().map(c => c.id))]);
  }

  isCheckEnabled(id: string): boolean {
    return this.enabledChecks().includes(id);
  }

  toggleCheck(id: string): void {
    const current = this.enabledChecks();
    this.enabledChecks.set(current.includes(id) ? current.filter(c => c !== id) : [...current, id]);
  }

  async save(): Promise<void> {
    if (this.saving() || !this.canEdit()) return;

    this.issues.set(rangeIssues(this.form));
    if (this.form.invalid || this.issues().length > 0) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);
    this.conflict.set(null);

    try {
      const settings = settingsFromForm(this.form, this.baseSettings, this.enabledChecks());
      const saved = await this.api.save(this.gamme(), {
        settings,
        // La version lue est renvoyée : l'API refuse si quelqu'un a écrit entre-temps.
        ...(this.profile() ? { expectedVersion: this.profile()!.version } : {}),
      });
      this.applyProfile(saved);
      this.message.set(`Profil enregistré (version ${saved.version})`);
    } catch (err) {
      if (err instanceof ProfileConflictError) {
        this.conflict.set(err);
      } else {
        this.error.set('Enregistrement impossible — réessayez');
      }
    } finally {
      this.saving.set(false);
    }
  }

  async reload(): Promise<void> {
    this.conflict.set(null);
    await this.load();
  }

  async resetToDefaults(): Promise<void> {
    if (!this.canEdit()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      this.applyProfile(await this.api.reset(this.gamme()));
      this.message.set('Profil réinitialisé aux valeurs par défaut');
    } catch {
      this.error.set('Réinitialisation impossible — réessayez');
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.canEdit() || this.gamme() === DEFAULT_PROFILE) return;
    if (!globalThis.confirm(`Supprimer définitivement le profil « ${this.gamme()} » ?`)) return;

    try {
      await this.api.remove(this.gamme());
      await this.router.navigate(['/profils']);
    } catch {
      this.error.set('Suppression impossible — réessayez');
    }
  }

  /**
   * Télécharge le profil au format d'échange.
   *
   * L'URL objet est révoquée aussitôt : la laisser vivre retiendrait le blob en
   * mémoire pour toute la durée de la page.
   */
  async exportProfile(): Promise<void> {
    try {
      const payload = await this.api.exportProfile(this.gamme());
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `websentry-profil-${payload.profile}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      this.error.set('Export impossible — réessayez');
    }
  }

  back(): void {
    void this.router.navigate(['/profils']);
  }
}
