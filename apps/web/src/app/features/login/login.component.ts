import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

/**
 * Écran de connexion.
 *
 * Le formulaire réactif reprend EXACTEMENT les bornes du schéma Zod partagé
 * (1–64 pour l'identifiant, 1–256 pour le mot de passe) : l'utilisateur est
 * averti avant l'appel réseau, et le serveur revalide de toute façon.
 */
@Component({
  selector: 'ws-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="flex min-h-screen items-center justify-center bg-sunken px-4">
      <section class="w-full max-w-sm rounded-xl bg-panel p-8 shadow-sm ring-1 ring-line">
        <h1 class="text-xl font-semibold text-content">WebSentry</h1>
        <p class="mt-1 text-sm text-content-subtle">Connectez-vous pour accéder à vos audits.</p>

        <form class="mt-6 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div>
            <label for="username" class="block text-sm font-medium text-content-muted">
              Identifiant
            </label>
            <input
              id="username"
              type="text"
              formControlName="username"
              autocomplete="username"
              maxlength="64"
              class="mt-1 w-full rounded-lg border border-field px-3 py-2 text-sm
                     focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              [attr.aria-invalid]="isInvalid('username')"
              [attr.aria-describedby]="isInvalid('username') ? 'username-error' : null"
            />
            @if (isInvalid('username')) {
              <p id="username-error" class="mt-1 text-xs text-danger-content">
                L'identifiant est requis (64 caractères maximum).
              </p>
            }
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-content-muted">
              Mot de passe
            </label>
            <input
              id="password"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              maxlength="256"
              class="mt-1 w-full rounded-lg border border-field px-3 py-2 text-sm
                     focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              [attr.aria-invalid]="isInvalid('password')"
              [attr.aria-describedby]="isInvalid('password') ? 'password-error' : null"
            />
            @if (isInvalid('password')) {
              <p id="password-error" class="mt-1 text-xs text-danger-content">
                Le mot de passe est requis.
              </p>
            }
          </div>

          @if (serverError()) {
            <!--
              Message rendu par interpolation Angular, donc échappé : même si l'API
              renvoyait du balisage, il s'afficherait comme du texte.
            -->
            <p
              role="alert"
              class="rounded-lg bg-danger-surface px-3 py-2 text-sm text-danger-content"
            >
              {{ serverError() }}
            </p>
          }

          <button
            type="submit"
            [disabled]="submitting()"
            class="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-accent
                   hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ submitting() ? 'Connexion…' : 'Se connecter' }}
          </button>
        </form>
      </section>
    </main>
  `,
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.maxLength(64)]],
    password: ['', [Validators.required, Validators.maxLength(256)]],
  });

  /** Un champ n'affiche son erreur qu'une fois touché — pas de rouge au chargement. */
  isInvalid(field: 'username' | 'password'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  async submit(): Promise<void> {
    if (this.submitting()) return;

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.serverError.set(null);

    const { username, password } = this.form.getRawValue();

    try {
      await this.auth.login(username, password);
      // `retour` ramène l'utilisateur là où une garde l'avait intercepté.
      const retour = this.route.snapshot.queryParamMap.get('retour');
      await this.router.navigateByUrl(retour ?? '/tableau-de-bord');
    } catch {
      // Le message vient du service, qui l'a déjà réduit à une formule sûre.
      this.serverError.set(this.auth.error() ?? 'Connexion impossible — réessayez');
      this.form.controls.password.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}
