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
    path: 'analyse',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/analysis/analysis.component').then(m => m.AnalysisComponent),
  },
  {
    path: 'analyse/lot',
    canActivate: [authGuard],
    loadComponent: () => import('./features/analysis/batch.component').then(m => m.BatchComponent),
  },
  {
    path: 'analyse/sitemap',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/analysis/sitemap.component').then(m => m.SitemapComponent),
  },
  {
    path: 'historique',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/scans/scan-history.component').then(m => m.ScanHistoryComponent),
  },
  {
    // Le site est identifié par ses COORDONNÉES (`domain`, `gamme`) et non par
    // un identifiant technique : c'est ce couple que connaît l'API, et l'URL
    // reste lisible et partageable.
    path: 'historique/site',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/scans/site-sessions.component').then(m => m.SiteSessionsComponent),
  },
  {
    // Un audit et ses pages. L'identifiant est celui de la session côté API :
    // c'est lui qui circule dans les liens de comparaison et d'historique.
    path: 'historique/audit/:sessionId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/scans/session-pages.component').then(m => m.SessionPagesComponent),
  },
  {
    // Le rapport archivé d'une page, rendu par le MÊME composant que l'analyse
    // en direct : un rapport relu six mois plus tard se lit comme au jour de sa
    // production.
    path: 'historique/page/:pageId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/scans/scan-detail.component').then(m => m.ScanDetailComponent),
  },
  {
    path: 'acces-refuse',
    loadComponent: () => import('./features/forbidden.component').then(m => m.ForbiddenComponent),
  },
  { path: '**', redirectTo: 'tableau-de-bord' },
];
