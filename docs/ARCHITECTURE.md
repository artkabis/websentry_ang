# Architecture — WebSentry v2

## Vue d'ensemble

```
websentry_ang/
├── apps/
│   ├── api/          @websentry/api  — Nest 12 sur adapter Fastify (ESM)
│   └── web/          @websentry/web  — Angular 22, standalone, zoneless
├── packages/
│   └── shared/       @websentry/shared — schémas Zod + RBAC (ESM + CJS)
└── docs/
```

Le package partagé est la **source unique de vérité** des contrats d'API. Le
backend en dérive ses DTO de validation, le frontend en valide les réponses
reçues. Aucune forme n'est décrite deux fois : une divergence entre les deux
côtés est structurellement impossible.

---

## Backend — flux d'une requête

```
Requête HTTP
   │
   ├─ helmet ..................... en-têtes OWASP (CSP, HSTS, frameguard…)
   ├─ @fastify/cookie ............ analyse des cookies
   │
   ├─ ThrottlerGuard ............. repousse l'abus avant tout calcul
   ├─ JwtAuthGuard ............... résout req.authUser et req.authVia
   │                               (fermé par défaut ; @Public() ouvre)
   ├─ CsrfGuard .................. double-submit sur mutations par cookie
   ├─ RankGuard .................. seuil de rang (@MinRank)
   ├─ PermissionsGuard ........... permission fine (@RequirePermission)
   │
   ├─ StandardSchemaValidationPipe  validation Zod de la charge utile
   ├─ Contrôleur ................. orchestration, aucune règle métier
   ├─ Service .................... règle métier
   ├─ Repository ................. SQL paramétré
   │
   └─ AllExceptionsFilter ........ forme d'erreur unique, aucune fuite
```

**L'ordre des gardes est significatif** — Nest les exécute dans leur ordre de
déclaration dans `AppModule`. `CsrfGuard` a besoin de `authVia` pour exempter les
clients Bearer ; `RankGuard` et `PermissionsGuard` ont besoin de `authUser`.
Réordonner ces providers casserait silencieusement les exemptions.

### Modules

| Module     | Rôle                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `config`   | Environnement validé par Zod **au démarrage** — le boot échoue plutôt que de servir à moitié configuré |
| `database` | Pool `mysql2` + repositories ; seul endroit où du SQL est écrit                                        |
| `security` | SSRF (`safeFetch`, `assertPublicUrl`), scrypt, garde CSRF                                              |
| `audit`    | Journal append-only                                                                                    |
| `rbac`     | Résolution rang + permissions fines avec scope de gammes                                               |
| `auth`     | Connexion, rotation du refresh, déconnexion, profil                                                    |
| `health`   | Sonde publique                                                                                         |

---

## Réglages et profils par gamme

Chaque gamme commerciale porte son propre jeu de règles d'analyse. Le profil
`default` est le **repli universel** : il s'applique quand la gamme n'est pas
détectée ou qu'aucun profil ne lui correspond.

### Stockage

Table `settings_profiles`, une ligne par gamme. Le passage du fichier à la base
est argumenté dans `DECISIONS.md` §10 ; l'essentiel tient en trois points :
verrouillage optimiste **atomique**, cohérence entre instances, et disparition de
la traversée de chemin comme surface d'attaque.

### Verrouillage optimiste

```
Client lit le profil        → version 3
Client modifie, enregistre  → PUT { settings, expectedVersion: 3 }
                                │
   UPDATE ... SET version = version + 1 WHERE gamme = ? AND version = 3
                                │
        ┌───────────────────────┴───────────────────────┐
   1 ligne touchée                              0 ligne touchée
   → version 4                                  → 409 + version courante
```

La condition et l'incrément sont dans la **même instruction**. Deux écritures
concurrentes ne peuvent pas toutes deux réussir : la seconde reçoit un 409 avec
la version courante, et l'interface propose un rechargement plutôt que
d'écraser silencieusement le travail d'autrui.

Omettre `expectedVersion` écrase sans condition — réservé aux créations et aux
imports délibérés.

### Réglages globaux

`/settings` **est** le profil `default` (cf. `DECISIONS.md` §11). Les deux
endpoints coexistent pour la compatibilité des clients, sur une seule ligne.

### Export / import

L'enveloppe d'export est versionnée et autodescriptive : un fichier versionné
dans Git doit pouvoir être relu sans contexte extérieur. À l'import, la gamme de
destination vient de **l'URL**, jamais du fichier — laisser le fichier choisir sa
cible ouvrirait un écrasement non voulu. La version source est exportée pour
information mais jamais réimportée : la base réattribue la sienne.

### Registre des critères

26 critères visibles et 263 sous-critères, servis depuis le paquet partagé, donc
sans accès en base. L'éditeur de profils s'adapte à un ajout côté backend sans
redéploiement du frontend.

### Validation

Le schéma `AnalysisSettings` est appliqué **à l'écriture ET à la lecture**. La
seconde validation n'est pas redondante : une ligne peut avoir été écrite par une
version antérieure du schéma, ou modifiée à la main en base. Dans ce cas le
service retombe sur les défauts et le signale, plutôt que de propager une forme
inattendue jusqu'au moteur d'analyse.

---

## Modèle d'authentification

### Cookies

| Cookie       | httpOnly | Durée  | Chemin                 | Rôle                                               |
| ------------ | -------- | ------ | ---------------------- | -------------------------------------------------- |
| `ws_access`  | ✅       | 15 min | `/`                    | JWT HS256                                          |
| `ws_refresh` | ✅       | 7 j    | `/api/v1/auth/refresh` | Jeton opaque, à usage unique                       |
| `ws_csrf`    | ❌       | 7 j    | `/`                    | Double-submit — le front doit le relire            |
| `ws_role`    | ❌       | 7 j    | `/`                    | Étiquette d'affichage, **jamais** une autorisation |

Tous portent `SameSite=Strict`, et `Secure` en production.

Deux choix méritent d'être explicités :

- **`ws_csrf` et `ws_role` ne sont pas httpOnly, à dessein.** Le double-submit
  exige que le front relise le jeton pour le renvoyer en en-tête ; un site tiers,
  lui, ne peut pas le lire (politique d'origine identique) et ne peut donc pas
  forger la requête. `ws_role` n'est qu'un indice d'affichage : le rang qui fait
  autorité est celui du JWT signé, et une falsification de ce cookie ne change
  rien (test dédié dans la suite OWASP, §5).
- **`ws_refresh` est limité à son chemin.** Il n'est pas transmis aux autres
  endpoints, ce qui réduit d'autant sa surface d'exposition.

### Rotation du refresh token

```
POST /auth/refresh  (cookie ws_refresh)
   │
   ├─ empreinte SHA-256 → recherche en base (le jeton brut n'est jamais stocké)
   ├─ contrôles : non révoqué, non expiré, compte actif
   │
   ├─ TRANSACTION
   │    ├─ révocation de la session présentée
   │    └─ création de la nouvelle session
   │
   └─ nouveaux ws_access + ws_refresh + ws_csrf
```

Le jeton présenté est **strictement à usage unique**. Un jeton volé puis rejoué
après un rafraîchissement légitime tombe sur une session révoquée : c'est la
détection de rejeu.

### Révocation immédiate

`users.token_version` est signée dans le JWT et confrontée à la base à chaque
requête. L'incrémenter invalide instantanément **tous** les access tokens du
compte, sans attendre leur expiration.

Si la base est injoignable, la vérification **refuse** (503). Voir
`DECISIONS.md` §8 pour le raisonnement.

---

## RBAC

Deux moteurs de décision, hérités de la v1 :

1. **Le rang** (10 tester · 30 editor · 50 admin · 100 super_admin) — ordre total,
   porte les seuils de route et les permissions par défaut.
2. **Les permissions fines** en base — délèguent un accès précis à un rang
   inférieur, éventuellement temporaire (`expires_at`) et restreint à certaines
   gammes.

```ts
@MinRank(RANKS.ADMIN)                       // seuil de rang
@RequirePermission(PERMISSIONS.USERS_READ)  // permission fine
@Get('users')
```

Les deux gardes se cumulent : rang **ET** permission.

`RbacService.resolve()` applique, dans l'ordre : bypass super_admin (sans requête
en base) → grant explicite en base → repli sur les défauts du rang.

Le frontend applique **la même règle** dans `AuthService.hasPermission()`, afin
que l'interface n'affiche jamais une action que l'API refuserait — ni l'inverse.
Les gardes de route Angular servent l'expérience, **pas** la sécurité : la
protection réelle est posée côté serveur, et contourner une garde côté client ne
donne accès à aucune donnée.

---

## Protection SSRF

Portée intégralement depuis la v1 — logique identique, emballage Nest.

Quatre défenses cumulées :

1. **Protocoles** restreints à `http`/`https`.
2. **Résolution DNS multi-enregistrement** : si **une seule** adresse retournée
   est privée, l'URL est rejetée. Sans cela, un domaine publiant à la fois une IP
   publique et `127.0.0.1` passerait une politique « au moins une adresse
   publique ».
3. **Épinglage de la connexion** sur les IP validées : le `lookup` d'undici est
   court-circuité, ce qui ferme la fenêtre de DNS rebinding entre la validation
   et le connect.
4. **Re-validation par saut** : les redirections sont suivies manuellement.
   Sans cela, un `302` vers `http://169.254.169.254/` contournerait tout le reste.

La blocklist couvre les plages privées, loopback, link-local (métadonnées cloud),
CGNAT, TEST-NET, multicast et réservées, en IPv4, IPv6, IPv4-mappé-IPv6 et NAT64.
**Toute forme non reconnue est refusée par défaut.**

---

## Frontend

- **Standalone components**, signals pour l'état local, **zoneless** (zone.js
  n'est pas embarqué).
- **Trois intercepteurs**, dans un ordre significatif :
  1. `credentials` — attache les cookies **aux seules requêtes vers notre API** ;
     l'activer globalement les enverrait à toute origine contactée.
  2. `csrf` — joint le jeton aux mutations uniquement.
  3. `auth` — rattrape les 401, tente **une** rotation, rejoue la requête. La
     rotation est **partagée** entre requêtes concurrentes : dix 401 simultanés
     déclencheraient sinon dix rotations, dont neuf invalideraient le jeton
     obtenu par la première.
- **Résolution de session au démarrage** : les cookies étant httpOnly, `/auth/me`
  est le seul moyen de savoir si une session existe.

---

## Tests

| Suite              | Emplacement                   | Volume | Seuil                           |
| ------------------ | ----------------------------- | ------ | ------------------------------- |
| Unitaires backend  | `apps/api/src/**/*.spec.ts`   | 402    | 85 % global, **100 %** sécurité |
| E2E API            | `apps/api/test/*.e2e-spec.ts` | 23     | —                               |
| Sécurité OWASP     | `apps/api/test/security/`     | 83     | —                               |
| Unitaires frontend | `apps/web/src/**/*.spec.ts`   | 97     | 80 %                            |
| E2E navigateur     | `apps/web/e2e/`               | 9      | —                               |

Les suites E2E montent l'application **assemblée** (adapter Fastify, helmet,
cookies, gardes globales) et la sollicitent par HTTP réel : ce qui est vérifié
est ce qu'un attaquant obtiendrait en parlant à l'API, et non le comportement de
services isolés.

La base est simulée en mémoire dans ces suites — le sujet y est la décision de
sécurité, pas le dialecte SQL. La correction des requêtes est couverte par les
tests unitaires de repository (séparation requête/paramètres) et, à terme, par
des tests d'intégration contre un conteneur MariaDB éphémère (voir _Reste à
faire_).

---

## Reste à faire

Modules non encore migrés (priorités 3 à 7 du cahier des charges) : historique
des scans, gestion des utilisateurs, analyse (SSE + Piscina), feedback,
messagerie, analytics, supervision, portail documentaire.

Dettes identifiées sur le périmètre déjà livré :

- **Tests d'intégration MariaDB** — conteneur éphémère en CI, pour valider le SQL
  réel des repositories. Devient plus important avec le module 2 : le
  verrouillage optimiste repose sur le comportement d'`UPDATE ... WHERE version`,
  aujourd'hui reproduit fidèlement par un double mais non exercé contre MariaDB.
- **Script d'import des profils v1** — lire les `settings-{gamme}.json` existants
  et les charger en base au moment de la bascule.
- **Édition des listes longues** — l'éditeur couvre les seuils numériques et les
  critères actifs ; les mots exclus, domaines exclus, règles par page et
  pondérations sont CONSERVÉS mais pas encore éditables dans l'interface.
- **Couverture E2E du SSRF** — la politique est couverte à 100 % en unitaire,
  mais aucune route de la priorité 1 n'émet de requête sortante. À lever dès la
  première route sortante (module 4). Un marqueur explicite le rappelle dans la
  suite OWASP, §8.
- **Journal d'audit append-only en base** — l'absence de méthode `UPDATE`/`DELETE`
  est garantie côté applicatif et testée ; la verrouiller aussi par des droits
  MariaDB (`GRANT INSERT, SELECT` uniquement) serait plus robuste.
