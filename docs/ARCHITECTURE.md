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

## Historique des scans

### Modèle hiérarchique

Trois niveaux, repris **tels quels** de la base v1 en production (cf.
`DECISIONS.md` §14) :

```
sites            un couple (domaine, gamme) — identité stable dans le temps
  └─ scan_sessions   un lancement d'audit (scan unique ou batch)
       └─ scan_pages   une URL analysée, qui porte le rapport complet
```

L'identité d'un site est la colonne générée `identity_key` = `domain|gamme`.
Un `UNIQUE (domain, gamme)` ne suffirait pas : deux `NULL` n'étant jamais égaux
en SQL, le site « sans gamme » serait dupliqué à chaque scan.

### Stockage du rapport, à trois étages

| Âge du scan                     | Stockage          | Accès                       |
| ------------------------------- | ----------------- | --------------------------- |
| < `SCAN_COMPRESS_AFTER_DAYS`    | `report` en clair | immédiat                    |
| jusqu'à `SCAN_PURGE_AFTER_DAYS` | `report_gz` gzip  | décompression à la demande  |
| au-delà                         | résumé seul       | **410 Gone** sur le rapport |

`check_summary` n'est **jamais** purgé. C'est ce qui permet de comparer deux
audits vieux de deux ans, longtemps après que leur détail a disparu.

`report_purged_at` distingue « effacé par la rétention » de « jamais écrit » —
la v1 confondait les deux et répondait 404 dans les deux cas (`DECISIONS.md`
§15).

### Rétention

Travail de fond lancé au démarrage puis toutes les 24 h, par **lots bornés** :

```
findCompressible(jours, lot) → gzip en JS → UPDATE ... CASE groupé
purge(jours, lot)            → vide report/report_gz, DATE report_purged_at
countPending()               → ce qui reste : tracé en WARN si non nul
```

Le minuteur est `unref()` : sans cela, le processus refuserait de s'arrêter
pendant les heures séparant deux passages, et un conteneur qui ne répond plus à
`SIGTERM` finit tué de force.

### Comparaison de deux audits

```
GET /scans/sessions/:a/compare/:b
       │
       ├─ refus 400 si les deux sessions ne partagent pas le même site
       ├─ le plus ANCIEN devient la référence, quel que soit l'ordre reçu
       ├─ appariement des pages par URL (seule clé stable entre deux lancements)
       └─ diff : dégradations ET améliorations, tri déterministe
```

Les règles de comparaison vivent dans `packages/shared/src/scan-comparison.ts` :
le backend produit le diff, le frontend rejoue les mêmes règles pour trier et
regrouper. Une seule définition de ce que « régresser » veut dire.

`na` (non applicable) est **hors** de l'échelle de santé : le compter comme un
échec ferait passer un changement de périmètre pour un effondrement de qualité.

### Modèle d'accès

| Route                    | Ouverture                                         |
| ------------------------ | ------------------------------------------------- |
| Lectures de l'historique | `history:read` (admin et éditeur par défaut)      |
| Suppressions             | `history:delete` (admin par défaut)               |
| `GET /scans/mine/:id`    | tout compte authentifié, **cloisonné par auteur** |

Le refus sur `/scans/mine` est un **404 et non un 403** : distinguer les deux
ferait de la route un oracle permettant d'énumérer les audits d'autrui.

Aucune route n'écrit dans l'historique : l'ingestion se fait en process
(`DECISIONS.md` §16).

---

## Moteur d'analyse

### Chaîne d'exécution

```
POST /analyze
  │
  ├─ schéma : protocole restreint à http/https (1re barrière SSRF)
  ├─ PageFetcherService → SsrfService.safeFetch (DNS multi-adresses, IP épinglée)
  ├─ résolution du profil : gamme DÉTECTÉE < profil CHOISI < surcharges
  ├─ AnalysisRunnerService → thread Piscina (repli en ligne)
  │     └─ orchestrateur : règles par page → analyseurs en parallèle → polarité
  └─ ScansService.record() — en process, jamais exposé en HTTP
```

### Isolation CPU

Le parse du DOM est du calcul pur. Le pool est dimensionné à **un thread de
moins que de cœurs** : le thread principal doit continuer à servir les requêtes
pendant qu'un lot tourne.

Le worker est du **JavaScript compilé** — un thread Piscina est un vrai thread
Node, sans la transformation TypeScript de l'outillage de développement. Son
existence est vérifiée AVANT la création du pool : en développement, l'analyse
s'exécute en ligne et le démarrage le dit.

### Flux SSE

Un flux SSE prend la main sur la réponse : dès le premier octet écrit, le filtre
d'exceptions global ne peut plus rien produire. `SseWriter` refait donc à la
main tout ce que le filtre garantit ailleurs — message assaini choisi **par
type** d'erreur, jamais recopié depuis l'exception.

La progression traverse un `MessageChannel` transféré au worker, et se mesure
sur les **critères réellement terminés** : une barre qui avance sur une minuterie
ment dès que le site analysé est lent.

### Analyseurs

Un analyseur est une fonction **pure** d'une page et de réglages vers un
résultat : ni base, ni état partagé, ni injection. C'est ce qui permet de
l'exécuter dans un worker en ne transportant que du JSON, et de le tester sans
rien monter.

Portés à ce jour (7 sur les 29 de la v1) : `METAS`, `HN_STRUCTURE`,
`CONTENT_LENGTH`, `CANONICAL`, `OPEN_GRAPH`, `LANG`, `REDIRECTS`. Tous purs,
sans requête sortante.

Restent à porter, par ordre de dépendance croissante :

| Nature                      | Critères                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DOM pur                     | `HN_LENGTH`, `BOLD`, `FAVICON`, `TRACKING`, `STRUCTURED_DATA`, `ROBOTS_META`, `DUDA_PARAMS`, `CTA`, `LOGO`, `PICTOGRAM`, `NAV_STRUCTURE`, `ACCESSIBILITY`, `SPLIT_LINKS`, `DATA_BINDING`, `MENTIONS_LEGALES` |
| DOM + cartographie de liens | `LINKS`, `ANCHOR_TEXT`                                                                                                                                                                                       |
| Requêtes sortantes          | `IMAGES` (poids), `BROKEN_LINKS`, `DUPLICATE_IMAGES`, `MENTIONS_LEGALES_DATA`, `CONTRAST_V2`                                                                                                                 |

Les derniers demandent une capacité de requête **dans le worker** : la politique
SSRF devra y être instanciée, jamais contournée.

### Règles par page

Un profil vaut pour un site ; certaines pages appellent des exceptions — une
page de contact n'a pas à contenir 300 mots. Les règles produisent des réglages
**éphémères**, dans un type `EffectiveSettings` distinct des réglages persistés :
la v1 logeait `hnByTag` dans ces derniers avec un commentaire « jamais
persisté », garantie qui tient jusqu'à ce que quelqu'un ne le lise pas.

### Écran d'analyse — trois niveaux de lecture

L'écran `/analyse` ne présente pas les vingt-neuf critères au même rang, comme
le fait la v1. Un rapport dont la grande majorité des lignes sont vertes
s'apprend à survoler, et qui le survole rate aussi les rouges. La lecture est
donc hiérarchisée :

| Niveau | Contenu                                   | Visible d'emblée          |
| ------ | ----------------------------------------- | ------------------------- |
| 1      | Score, verdict, 3 corrections à mener     | Oui                       |
| 2      | Critères groupés SEO / Technique / Design | Filtrés sur « à traiter » |
| 3      | Occurrences et recommandations            | Au dépli d'un critère     |

Les corrections prioritaires sont triées par gravité (échec avant
avertissement) puis par **poids du critère** dans le score, l'identifiant du
critère départageant les égalités pour que l'ordre soit stable d'un rendu à
l'autre. Les critères de poids nul n'y figurent jamais : corriger ce qui ne
pèse rien sur le score n'est pas une priorité.

Le filtre par défaut masque les critères conformes, mais **le nombre de
critères masqués reste affiché**, globalement et non par groupe : un groupe
entièrement conforme disparaît de la liste, et son compte disparaîtrait avec
lui s'il était rendu à l'intérieur.

Le flux passe par `fetch` + `ReadableStream`, pas par `EventSource` : celui-ci
ne sait faire que du GET, ce qui exposerait l'URL auditée dans une barre
d'adresse et dans les journaux des proxys. Corollaire assumé : la reconnexion
automatique d'`EventSource` est perdue, donc un flux coupé avant la fin est
signalé explicitement plutôt que silencieusement relancé.

Le lien « Voir dans la page » s'appuie sur les fragments de texte
(`#:~:text=`). Les caractères `-` et `,` y sont des séparateurs de syntaxe :
seul le contenu est encodé, jamais les séparateurs que nous émettons.

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

| Suite              | Emplacement                        | Volume | Seuil                           |
| ------------------ | ---------------------------------- | ------ | ------------------------------- |
| Paquet partagé     | `packages/shared/src/**/*.spec.ts` | 337    | 95 %                            |
| Unitaires backend  | `apps/api/src/**/*.spec.ts`        | 972    | 85 % global, **100 %** sécurité |
| E2E API            | `apps/api/test/*.e2e-spec.ts`      | 95     | —                               |
| Sécurité OWASP     | `apps/api/test/security/`          | 216    | —                               |
| Unitaires frontend | `apps/web/src/**/*.spec.ts`        | 387    | 80 %                            |
| E2E navigateur     | `apps/web/e2e/`                    | 35     | —                               |

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

Modules non encore migrés (priorités 5 à 7 du cahier des charges) : gestion des
utilisateurs, feedback, messagerie, analytics, supervision, portail
documentaire.

Le module 4 est livré dans son ARCHITECTURE (pipeline, isolation CPU, SSE,
sitemap, sécurité) avec 7 analyseurs sur 29. Les 22 restants sont listés plus
haut ; ils ne demandent aucun changement de structure, sauf les cinq qui émettent
des requêtes sortantes.

Dettes identifiées sur le périmètre déjà livré :

- **Tests d'intégration MariaDB** — conteneur éphémère en CI, pour valider le SQL
  réel des repositories. La dette s'alourdit à chaque module : le verrouillage
  optimiste du module 2 repose sur `UPDATE ... WHERE version`, et le module 3
  ajoute une fonction fenêtre (`ROW_NUMBER() OVER (PARTITION BY …)`), une
  recherche `MATCH … AGAINST` en mode booléen, une colonne générée `STORED`, des
  cascades de clés étrangères et un `UPDATE … ORDER BY … LIMIT`. Tout cela est
  reproduit fidèlement par des doubles, mais rien n'est exercé contre MariaDB —
  or c'est précisément le genre de SQL dont le comportement varie d'un moteur et
  d'une version à l'autre.
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
- **Corbeille des scans supprimés** — la v1 dispose d'une table `scan_archive`
  qui conserve les sessions supprimées en masse avant purge, avec restauration
  et export. Le module 3 livre les suppressions **sans** ce filet. La table
  existe et n'est pas touchée ; le module qui la réexpose reste à faire, et
  d'ici là une suppression est définitive — ce que l'interface annonce.
- **Détail d'une page dans l'interface** — l'API sert le rapport complet d'une
  page (`GET /scans/:id`), avec le 410 des rapports purgés. Le blocage est levé
  depuis que le module 4 livre le rendu d'un rapport : il reste à brancher
  l'historique sur ces mêmes composants, et à traiter le 410 par un état dédié
  plutôt que par une erreur générique.
- **Thème sombre** — le cap UX (`CLAUDE.md` §2) le demande dès la conception.
  Les écrans existants sont en clair uniquement ; n'en convertir qu'une partie
  serait pire que rien. La bascule est un passage transverse sur les jetons de
  design, à mener d'un bloc plutôt qu'au fil des modules.
- **Analyseurs restants** — 22 des 29 critères de la v1 ne sont pas encore
  portés. Le rapport produit est donc partiel, et le score global porte sur les
  seuls critères présents. À lever avant toute bascule de production.
- **Lot et sitemap dans l'interface** — `/analyse` couvre la page unitaire ; le
  backend expose aussi le lot et le sitemap, sans écran. Le rendu du rapport
  étant désormais factorisé (`report-view.ts` et ses cartes), un écran de lot
  consiste surtout à empiler des rapports et à suivre plusieurs flux, pas à
  réécrire l'affichage.
- **Requête sortante dans le worker** — cinq analyseurs vérifient des ressources
  distantes (poids d'images, liens cassés, contraste). Ils demandent que la
  politique SSRF soit instanciée DANS le thread, ce que l'architecture prévoit
  mais que rien n'exerce encore.
- **Suppressions depuis l'interface** — l'API expose les quatre portées (pages,
  session, site, domaine) et la suite sécurité les couvre ; l'interface ne les
  propose pas encore. Elles attendent la corbeille : offrir une suppression
  définitive d'un domaine entier en un clic, sans filet, serait imprudent.
