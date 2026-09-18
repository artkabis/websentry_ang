import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards/auth.guard';

/**
 * Table de routage.
 *
 * Les composants sont chargés paresseusement : l'écran de connexion n'embarque
 * pas le code du tableau de bord, ce qui allège le premier rendu pour un visiteur
 * non authentifié.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tableau-de-bord' },
  {
    path: 'connexion',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'tableau-de-bord',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'profils',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/profiles/profiles-list.component').then(m => m.ProfilesListComponent),
  },
  {
    // `withComponentInputBinding()` lie le paramètre de route à l'entrée
    // `gamme` du composant — pas d'injection manuelle d'ActivatedRoute.
    path: 'profils/:gamme',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/profiles/profile-editor.component').then(m => m.ProfileEditorComponent),
  },
  {
    path: 'acces-refuse',
    loadComponent: () => import('./features/forbidden.component').then(m => m.ForbiddenComponent),
  },
  { path: '**', redirectTo: 'tableau-de-bord' },
];
