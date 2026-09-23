import type { Routes } from '@angular/router';
import { authGuard, guestGuard, permissionGuard, superAdminGuard } from './core/guards/auth.guard';

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
    // Les retours ne sont gardés QUE par l'authentification : déposer est
    // ouvert à tous, et la lecture est restreinte par l'API aux retours dont
    // on est l'auteur. Une garde par permission fermerait l'écran « mes
    // retours » à ceux-là mêmes qu'on veut faire remonter des retours.
    path: 'retours',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/feedback/feedback-list.component').then(m => m.FeedbackListComponent),
  },
  {
    // AVANT rien d'autre : `retours/nouveau` n'a pas de segment dynamique
    // concurrent, mais l'ordre reste explicite.
    path: 'retours/nouveau',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/feedback/feedback-submit.component').then(m => m.FeedbackSubmitComponent),
  },
  {
    // La messagerie n'est gardée QUE par l'authentification : lire sa boîte
    // n'exige aucune permission, et l'API cloisonne par la jointure. Une garde
    // de permission ici fermerait la boîte à ceux-là mêmes à qui l'on écrit.
    path: 'messages',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/messages/messages-inbox.component').then(m => m.MessagesInboxComponent),
  },
  {
    // Composer, en revanche, exige `messages:write` — en miroir du décorateur
    // posé sur la route de l'API. La garde sert l'EXPÉRIENCE : elle évite
    // d'afficher un formulaire dont l'envoi serait refusé.
    path: 'messages/nouveau',
    canActivate: [authGuard, permissionGuard('messages:write')],
    loadComponent: () =>
      import('./features/messages/message-compose.component').then(m => m.MessageComposeComponent),
  },
  {
    // Les comptes : lecture gardée par `users:read`, en miroir du décorateur
    // posé sur la route de l'API. La garde sert l'EXPÉRIENCE — elle évite
    // d'afficher un écran que l'API refuserait de nourrir — pas la sécurité.
    path: 'administration/comptes',
    canActivate: [authGuard, permissionGuard('users:read')],
    loadComponent: () =>
      import('./features/admin/users-list.component').then(m => m.UsersListComponent),
  },
  {
    // AVANT `:id`, sans quoi « nouveau » serait lu comme un identifiant — et
    // rejeté par la validation UUID de l'API.
    path: 'administration/comptes/nouveau',
    canActivate: [authGuard, permissionGuard('users:write')],
    loadComponent: () =>
      import('./features/admin/user-editor.component').then(m => m.UserEditorComponent),
  },
  {
    path: 'administration/comptes/:id',
    canActivate: [authGuard, permissionGuard('users:read')],
    loadComponent: () =>
      import('./features/admin/user-editor.component').then(m => m.UserEditorComponent),
  },
  {
    // La supervision est une donnée d'EXPLOITATION, gardée par `health:read`
    // que le rang administrateur détient : constater qu'un pool est tombé ne
    // doit pas demander le rang le plus élevé.
    path: 'administration/supervision',
    canActivate: [authGuard, permissionGuard('health:read')],
    loadComponent: () =>
      import('./features/supervision/supervision.component').then(m => m.SupervisionComponent),
  },
  {
    // Le journal est réservé au rang 100 : `audit:read` existe au catalogue
    // mais n'est accordable à personne, et une garde par permission laisserait
    // croire qu'on peut le déléguer.
    path: 'administration/journal',
    canActivate: [authGuard, superAdminGuard],
    loadComponent: () =>
      import('./features/admin/audit-log.component').then(m => m.AuditLogComponent),
  },
  {
    path: 'acces-refuse',
    loadComponent: () => import('./features/forbidden.component').then(m => m.ForbiddenComponent),
  },
  { path: '**', redirectTo: 'tableau-de-bord' },
];
