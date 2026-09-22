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
| `audit`    | Journal append-only ; lecture paginée et filtrée, réservée au rang 100                                 |
| `rbac`     | Résolution rang + permissions fines avec scope de gammes                                               |
| `auth`     | Connexion, rotation du refresh, déconnexion, profil                                                    |
| `users`    | Administration des comptes — CRUD, mots de passe, permissions fines ; exige la base                    |
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

## Gestion des comptes

Le module expose `/users` et ne fonctionne **qu'avec la base** : sans elle, les
routes rendent `503` plutôt qu'une interface à moitié vivante (décision 39).

### Deux dépôts pour une seule table

`UserRepository` sert l'authentification ; `UserAdminRepository` sert
l'administration. Le second ne lit **jamais** `password_hash`, `token_version`
ni `failed_logins` : la liste des colonnes est explicite dans la requête, donc
ce qui ne doit pas sortir n'est même pas chargé. Le premier garde son
implémentation « sans base » (décision 38) ; le second n'en a pas.

### Ordre des décisions sur une écriture

Chaque écriture traverse les mêmes contrôles, dans cet ordre — l'ordre compte,
car il détermine le code d'erreur rendu :

1. `503` — base absente ;
2. `404` — compte inexistant (avant tout contrôle de rang : un rang ne se
   compare pas à celui d'un compte qui n'existe pas) ;
3. `403` — auto-modification, rang cible supérieur ou égal, délégation d'une
   permission non détenue ;
4. `400` — dernier compte d'administration actif ;
5. `409` — identifiant déjà pris.

Le détail et la justification de chaque règle sont en décision 40.

### Révocation

Toute écriture qui change ce que le jeton affirme incrémente `token_version` —
rang, statut, mot de passe, permission fine. Une suspension ou une
réinitialisation de mot de passe ferme **en plus** les sessions ouvertes. La
suite de bout en bout le vérifie en gardant une session ouverte avant
l'écriture, puis en constatant son `401`.

### Permissions de route

| Route                             | Permission     |
| --------------------------------- | -------------- |
| `GET /users`, `GET /users/:id`    | `users:read`   |
| `GET /users/:id/permissions`      | `users:read`   |
| `POST /users`, `PATCH /users/:id` | `users:write`  |
| `POST /users/:id/password`        | `users:write`  |
| `PUT`/`DELETE …/permissions…`     | `users:write`  |
| `DELETE /users/:id`               | `users:delete` |

`users:delete` n'appartient **pas** au jeu par défaut du rang administrateur :
supprimer un compte est réservé au rang 100, ou à une délégation explicite. La
délégation ouvre la route, elle n'efface pas le garde-fou de rang — un test le
prouve.

La réinitialisation du mot de passe est une route **distincte** de la mise à
jour : mêler le mot de passe aux autres champs permettrait de le changer en
corrigeant un courriel, et rendrait la trace d'audit ambiguë sur ce qui a
réellement été fait. Le mot de passe n'entre **jamais** dans le journal — ni en
clair, ni haché : un journal se lit plus facilement qu'une table de comptes.

### Coquille applicative

L'en-tête est présent sur tous les écrans et porte trois choses : le retour au
tableau de bord, la **navigation principale**, et le choix d'apparence. Avant
elle, seize routes n'avaient qu'un point d'entrée, et trois écrans n'offraient
aucune sortie (décision 45).

Les entrées sont des **familles** et non des écrans, et chacune n'apparaît que
si l'utilisateur peut réellement ouvrir sa destination : `Comptes` demande
`users:read`, `Journal` demande le rang 100. L'écran courant est signalé par
`aria-current="page"`, y compris depuis un écran interne à la famille
(`/analyse/lot` marque `Analyse`).

Sous la largeur d'un téléphone, la barre se replie derrière un bouton dont
l'état est porté par `aria-expanded` ; une navigation la referme.

#### Lien d'évitement

Premier arrêt de tabulation de chaque écran, il donne le focus au conteneur du
contenu routé (`#contenu`, `tabindex="-1"`). Deux détails le font fonctionner :

- le saut est traité **en code** (`preventDefault` puis `focus`) — avec une base
  de document à la racine, un fragment nu est résolu en URL absolue et le
  routeur quitterait l'écran en cours ;
- son remplissage n'est appliqué **qu'au focus** — posé en permanence, il
  écraserait le `padding: 0` de `sr-only` et laisserait une cible cliquable de
  24 px dans le coin, invisible mais atteignable au pointeur.

Une fois focalisé, il mesure au moins 24 × 24 px (WCAG 2.5.8).

### Écrans d'administration

Trois routes, gardées en miroir des décorateurs de l'API :

| Route                             | Garde côté client | Garde côté API |
| --------------------------------- | ----------------- | -------------- |
| `/administration/comptes`         | `users:read`      | `users:read`   |
| `/administration/comptes/nouveau` | `users:write`     | `users:write`  |
| `/administration/comptes/:id`     | `users:read`      | `users:read`   |
| `/administration/journal`         | rang 100          | rang 100       |

`nouveau` est déclarée **avant** `:id` : dans l'autre ordre, « nouveau » serait
lu comme un identifiant, et rejeté par la validation UUID de l'API.

Les gardes du routeur servent l'EXPÉRIENCE, pas la sécurité : elles évitent
d'afficher un écran que l'API refuserait de nourrir. Les contourner ne donne
accès à aucune donnée.

#### L'interface rejoue les garde-fous

Les règles de la décision 40 dépendent de l'acteur ET de la cible : aucun schéma
ne les porte. L'interface les recalcule (`refusPrevisible`, `rangsAttribuables`)
pour ne pas offrir un geste qu'elle sait voué au 403 — et affiche la raison à la
place du bouton. La liste déroulante des rangs ne propose jamais un rang
supérieur ou égal à celui de l'acteur ; la liste des permissions délégables se
borne à ce qu'il détient lui-même. Détail et coût en décision 42.

Les messages d'erreur de l'API sont repris **tels quels** quand elle en donne :
« c'est le dernier compte d'administration actif » ne peut pas être reconstitué
côté client, qui ignore combien d'administrateurs existent.

#### Mot de passe

Créé ou réinitialisé, il est affiché **en clair** : il faut pouvoir le
transmettre, et il n'est plus jamais visible ensuite. Le générateur tire dans le
générateur cryptographique du navigateur, corrige le biais du modulo par rejet,
et exclut les caractères qui se recopient mal (`O`/`0`, `I`/`l`/`1`).

#### Journal d'audit

Lecture seule, filtres reflétés dans l'URL, détail de chaque trace replié par
défaut — sa forme dépend de l'action, et l'étaler ferait un mur de JSON. Aucun
geste d'écriture n'est proposé, parce qu'aucun n'existe côté serveur : le dépôt
n'a ni `UPDATE` ni `DELETE`, et un scénario vérifie qu'aucune route ne vient
contourner cette contrainte.

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

Les **29 critères de la v1 sont portés**, en trois natures :

| Nature                          | Critères                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM pur (23)                    | `METAS`, `HN_STRUCTURE`, `HN_LENGTH`, `CONTENT_LENGTH`, `CANONICAL`, `OPEN_GRAPH`, `LANG`, `REDIRECTS`, `BOLD`, `FAVICON`, `TRACKING`, `STRUCTURED_DATA`, `DUDA_PARAMS`, `CTA`, `LOGO`, `PICTOGRAM`, `NAV_STRUCTURE`, `ACCESSIBILITY`, `SPLIT_LINKS`, `DATA_BINDING`, `MENTIONS_LEGALES_DATA`, `DUPLICATE_IMAGES`, `CONTRAST_V2` |
| DOM + cartographie de liens (2) | `LINKS`, `ANCHOR_TEXT`                                                                                                                                                                                                                                                                                                           |
| Requêtes sortantes (4)          | `ROBOTS_META`, `IMAGES` (poids), `BROKEN_LINKS`, `MENTIONS_LEGALES`                                                                                                                                                                                                                                                              |

#### La sonde réseau, porte de sortie unique

Un analyseur ne connaît pas `fetch` : il reçoit une `NetworkProbe`. Elle **ne
lève jamais** — un lien injoignable est un résultat d'analyse, pas une panne
d'analyse — et se lit en deux couches.

**Le moteur** (`probe-engine.ts`) sait joindre une URL, et ne fait jamais deux
fois le même travail :

- **cache par URL partagé par le processus**, avec un TTL court pour les échecs
  (un hôte qui expire une fois n'est pas mort pour dix minutes) ;
- **partage des requêtes en vol** : le cache n'étant écrit qu'au retour, deux
  demandes simultanées sur la même URL partageraient sinon rien ;
- **portail de concurrence global**, et non par appel : quatre critères réseau
  travaillant de front ouvriraient sans lui quatre fois plus de connexions que
  prévu sur le site audité.

Il vit dans le **processus principal**, et les threads lui parlent par un canal
(`probe-rpc.ts`). Un moteur par thread fragmenterait le cache exactement comme
le pool : le menu et le pied de page d'un site, présents sur toutes ses pages,
seraient revérifiés une fois par thread. La politique SSRF s'applique donc au
même endroit pour tous les chemins d'exécution — thread, repli en ligne, ou
appel direct.

**La couche de budget** (`network-probe.ts`) décide qui a le droit de sortir :

- un **quota par critère** (`CHECK_QUOTAS`), attribué d'avance. L'orchestrateur
  donne à chaque analyseur la vue de son critère, si bien qu'un rapport ne
  dépend plus de l'ordre dans lequel les analyseurs se réveillent ;
- un **plafond absolu par analyse** : une page hostile qui déclare dix mille
  images ne transforme pas WebSentry en amplificateur ;
- une **facturation au réel** : une réponse servie par le cache ou par une
  requête en vol est remboursée. Un lien déjà vu ne coûte rien.

Un quota atteint est un état à part (`exhausted`), jamais un défaut du site :
les critères l'annoncent en note d'information, hors décompte et hors barème.

#### Du site au lot, par son sitemap

`/analyse/sitemap` cherche le sitemap d'un site — ou lit celui qu'on lui donne
directement —, liste ses pages et en constitue une sélection. L'écran ne lance
RIEN : il verse la sélection à `/analyse/lot`, qui sait déjà suivre un flux et
afficher des rapports. La sélection voyage par l'état de navigation et non par
l'adresse : deux cents URL n'y tiennent pas, et les y mettre produirait un lien
intransmissible. L'écran de lot préremplit sa saisie, qui reste modifiable —
c'est ce qui rend le passage de relais lisible plutôt que magique.

#### Un lot s'affiche pendant qu'il tourne

`POST /analyze/batch/stream` émet chaque page DÈS qu'elle est terminée, rapport
compris. Le contrat existait dans le paquet partagé et rien ne le servait : le
lot ne répondait qu'en bloc, ce qui fige l'écran plusieurs minutes sur deux
cents pages avant de livrer des mégaoctets d'un coup. L'émetteur SSE et le
lecteur côté client sont GÉNÉRIQUES sur leur contrat — en écrire une seconde
version ferait diverger deux fois les mêmes précautions : validation avant
émission, bloc illisible ignoré, socket mort, interruption propre.

#### L'historique se parcourt jusqu'au rapport

Site → audits → pages → rapport. Le dernier maillon manquait : l'API servait le
rapport d'une page, aucun écran n'y menait. Les deux écrans ajoutés montent le
**même composant de rapport** que l'analyse en direct (`ws-report-view`) — un
rapport relu six mois plus tard se lit comme au jour de sa production, et deux
rendus séparés divergeraient au premier changement.

Le rapport purgé a son propre état, et non un message d'erreur : la rétention
l'a effacé, ce n'est pas une panne. Le résumé par critère voyage AVEC le refus
410, si bien qu'un lien ouvert directement — signet, message d'un collègue —
reste informatif.

#### Un seul parcours du document

`dom-walk.ts` porte ce que tous les critères faisaient chacun de leur côté :
remonter les ancêtres d'un élément, lire ses classes, trouver la première image
qu'il contient. Cheerio sait le faire — `parents`, `closest`, `is`, `find` —
mais chacun de ces appels reparse et recompile son sélecteur, ce qui en faisait
le poste le plus coûteux du moteur sur une page riche en liens. Les résultats
sont mémorisés par élément, dans des tables faibles qui disparaissent avec la
page : un conteneur de navigation est classé une fois, pas une fois par lien
qu'il porte.

#### Deux vocabulaires de zone, assumés

`link-zone.ts` classe un lien pour `LINKS` et `BROKEN_LINKS` ; `ANCHOR_TEXT`
garde le sien, qui reconnaît moins de conventions et les ordonne autrement — le
menu y prime sur le pied de page, alors que l'autre tranche d'abord le pied de
page. Les unifier changerait les zones ignorées, donc des verdicts : c'est un
arbitrage à instruire, pas un nettoyage à glisser dans une optimisation. Les
deux lectures se font sur les attributs, sans sélecteur CSS.

#### Le contraste sans navigateur

Les règles d'une feuille ne sont pas cherchées dans tout le document : un index
des classes, identifiants et balises réellement présents est construit en un
parcours, et chaque règle y puise ses candidats. Une règle qui ne peut viser
personne n'est jamais cherchée ; une règle réduite à sa clé (`.promo`, `#entete`,
`p`) est servie par l'index seul. L'extraction de clé est CONSERVATRICE : devant
une pseudo-classe fonctionnelle ou une classe échappée — `.md\:flex` — elle
renonce et la requête normale reprend la main.

`CONTRAST_V2` ne peut pas se lire dans le HTML : il faut résoudre la cascade.
Un micro-moteur CSS embarqué (`analysis/css/`) calcule les styles — spécificité,
héritage, custom properties, `@media`/`@layer`/`@supports`/`@container` — puis un
résolveur de fond effectif compose les couches semi-transparentes et remonte les
ancêtres jusqu'à une couleur opaque.

**Une feuille n'est découpée qu'une fois par worker.** La charte d'un site est
la même sur toutes ses pages : sur un lot, la même feuille était redécoupée
autant de fois qu'il y avait de pages, pour un résultat identique. Le découpage
et tout ce qui n'en dépend que — liste de sélecteurs, spécificité, clé d'index,
variables de palette — est mémorisé par TEXTE de feuille, dans un cache borné à
4 Mio de source par thread. Ce qui dépend de la page — filtrage `@media`, mise
en correspondance avec le document — est rejoué à chaque fois. Les règles
mémorisées sont partagées : leurs déclarations sont `Readonly` et gelées, sans
quoi une écriture en place se propagerait aux pages suivantes sans rien
signaler. Seules les feuilles à couche `@layer` ANONYME échappent au cache,
leur nom dépendant d'un compteur de page.

Le moteur **n'a pas de porte de sortie à lui** : il reçoit, ou non, une fonction
de lecture. C'est l'analyseur qui la construit sur la sonde réseau — donc sous
politique SSRF, sous plafond de volume (512 Kio par feuille) et sur le quota du
critère (`CONTRAST_V2: 8`). Au plus huit feuilles sont lues, dans l'ordre du
document. Ce qui est déclaré et ce qui a été lu sont comptés séparément : toute
feuille manquante devient un item `info` du rapport, parce qu'une mesure faite
sans la charte du site est une mesure faite sur des valeurs par défaut, et que
le rapport ne doit pas conclure comme s'il avait tout vu.

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

**L'état de l'écran vit dans l'adresse.** L'URL analysée et le filtre y sont
écrits (`?url=…&filtre=tous`), en REMPLAÇANT l'entrée d'historique plutôt qu'en
empilant : l'écran est un plan de travail, et un retour arrière doit ramener à
l'écran précédent, pas défaire un changement de filtre. Ouvrir un tel lien
relance l'analyse et rouvre la vue telle que l'expéditeur la voyait. Le filtre
par défaut ne s'écrit pas — une adresse ne porte que ce qui s'écarte du défaut.

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

### Sans base de données

`DB_ENABLED=false` sert à travailler sans MariaDB — la v1 le permettait, la v2
l'avait perdu. Trois dépôts reçoivent alors une implémentation locale, sous le
même jeton d'injection : ni l'authentification ni le RBAC ne savent laquelle ils
reçoivent.

| Dépôt        | Avec base          | Sans base                                  |
| ------------ | ------------------ | ------------------------------------------ |
| Utilisateurs | table `users`      | `apps/api/.dev-accounts.json` (empreintes) |
| Sessions     | `user_sessions`    | mémoire du processus                       |
| Permissions  | `user_permissions` | aucune — le rang seul décide               |

Ce qui ne change pas : mot de passe haché par le même service, verrouillage
après échecs, révocation par `token_version`, jeton de rafraîchissement à usage
unique. Le mode est refusé au démarrage si `NODE_ENV=production`.

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
- **Chargement différé par route** : seul le noyau part d'emblée (427 kio bruts,
  113 kio transférés). Le budget de bundle est calé juste au-dessus, avec une
  marge d'erreur de 53 kio : il **échoue le build**, il n'avertit pas.
- **La configuration PostCSS s'appelle `.postcssrc.json`** — le constructeur
  Angular ne lit que ce nom ou `postcss.config.json`. Sous tout autre nom, elle
  est ignorée EN SILENCE : Tailwind ne tourne pas, la feuille part avec sa
  directive `@tailwind` intacte, et l'application est livrée sans une seule
  classe utilitaire. C'est arrivé, et rien ne l'a signalé pendant quatre
  modules ; un scénario Playwright interroge désormais le rendu.

### Formulaires longs — replier sans cacher

L'éditeur de profil porte une centaine de contrôles : deux grilles de
vingt-neuf lignes, deux listes, et une carte par règle de page. Déplié d'un
bloc, il demandait **113 tabulations** pour atteindre « Enregistrer » — 230 avec
trois règles — et 6,5 écrans de défilement.

Ses sections sont désormais repliables (`ws-section-pliante`, bâti sur l'élément
de dépliage natif : clavier, lecteurs d'écran et recherche dans la page le
connaissent déjà). Deux règles le rendent utilisable plutôt que seulement plus
court :

1. **L'en-tête replié porte un résumé CHIFFRÉ** — « 29 actifs sur 29 », « 22
   mots exclus », « 1 règle : Pages de contact ». Un titre seul obligerait à
   ouvrir la section pour savoir si elle mérite d'être ouverte.
2. **L'état est retenu par section.** Un profil se règle en plusieurs passes ;
   refermer à chaque rechargement ce qu'on vient d'ouvrir ferait perdre le temps
   que le repli fait gagner.

Un lien d'évitement (WCAG 2.4.1) mène directement aux actions. Mesuré après :
**27 tabulations et 1,6 écran** à l'ouverture, et une règle de page coûte une
tabulation au lieu de trente-neuf. Le pire cas — tout ouvert — existe encore,
mais il est désormais un choix.

### Apparence — deux thèmes, une définition

Les gabarits ne nomment plus de teintes mais des RÔLES : `surface`, `panel`,
`sunken` pour les fonds ; `content`, `content-muted`, `content-subtle` pour le
texte ; `line` pour un filet décoratif et `field` pour la bordure d'un contrôle ;
`brand`, `danger`, `warn`, `ok`, `info` pour la marque et les états. Une classe
qui dirait `bg-slate-100` fige un gris clair dans le gabarit et devient illisible
sur fond sombre ; `bg-sunken` décrit l'intention, et chaque thème y répond.

Chaque jeton est défini UNE fois, avec `light-dark(clair, sombre)`. Le choix se
fait par `color-scheme` sur la racine — `light dark` par défaut, forcé par
`data-theme="clair"` ou `"sombre"`. Trois conséquences : pas de doublon de tout
le bloc sous `@media (prefers-color-scheme: dark)` ; la préférence du système
s'applique AVANT que le JavaScript démarre, donc sans écran clair qui clignote
(la politique de sécurité interdit tout script en ligne, un script bloquant est
donc exclu) ; et les contrôles natifs, barres de défilement et champs de
formulaire s'accordent seuls.

`ThemeService` ne peint rien : il pose l'attribut et conserve le choix. Trois
états, pas deux — « système » est l'absence de choix, donc la décision rendue à
la machine, ce qui n'est pas la même chose que « clair ».

**Tous les couples texte/fond tiennent WCAG 2.2 AA dans les DEUX thèmes**, et
c'est vérifié sur les couleurs calculées : la suite Playwright balaie chaque
élément portant du texte sur six écrans, résout les couleurs en sRGB par le
navigateur lui-même, et applique la formule de contraste. Un échantillon choisi
à la main ne prouverait que ce qu'on a pensé à y mettre.

### Ce qui garde le chargement initial mince

Deux réglages non évidents, que leur discrétion expose à être défaits :

1. **`import * as z from 'zod'`** dans le paquet partagé. L'import nommé
   (`import { z }`) rend un objet d'espace de noms déjà construit, qu'esbuild —
   le bundler d'Angular — ne sait pas élaguer : il embarquait les quarante
   fichiers de traduction de Zod et son convertisseur JSON Schema, soit plus de
   300 kio jamais appelés. Une règle ESLint interdit désormais la forme nommée.
2. **`sideEffects: false` dans les package.json des dossiers de sortie** du
   paquet partagé, écrits par `scripts/write-cjs-package.mjs`. Un bundler lit
   cette déclaration dans le package.json le **plus proche du fichier résolu** —
   celui de `dist/esm/`, pas celui du paquet. Sans elle, tout ce que le barillet
   réexporte est réputé impur : le catalogue des vingt-neuf critères, lu par les
   seuls écrans différés, voyageait dans le chargement initial.

---

## Tests

| Suite              | Emplacement                        | Volume | Seuil                           |
| ------------------ | ---------------------------------- | ------ | ------------------------------- |
| Paquet partagé     | `packages/shared/src/**/*.spec.ts` | 337    | 95 %                            |
| Unitaires backend  | `apps/api/src/**/*.spec.ts`        | 1698   | 85 % global, **100 %** sécurité |
| E2E API            | `apps/api/test/*.e2e-spec.ts`      | 104    | —                               |
| Sécurité OWASP     | `apps/api/test/security/`          | 230    | —                               |
| Unitaires frontend | `apps/web/src/**/*.spec.ts`        | 442    | 80 %                            |
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
sitemap, sécurité) avec les 29 analyseurs de la v1. Ce qui reste y tient à
l'interface, pas au moteur.

Dettes identifiées sur le périmètre déjà livré :

- **Fil d'Ariane sur les parcours profonds** — la navigation persistante est
  livrée (décision 45), mais `historique → site → audit → page` descend de
  quatre niveaux sans que l'écran dise où l'on se trouve dans cette chaîne. Deux
  écrans portent un fil d'Ariane écrit à la main (la fiche compte, l'éditeur de
  profil) ; les autres n'en ont pas. Un fil générique dérivé de la route
  demanderait de donner un libellé à chaque segment, y compris aux identifiants
  — ce qui suppose de charger la donnée avant de pouvoir nommer le niveau.

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
- **Polarité des sous-critères** — l'éditeur de profil couvre les seuils, les
  critères actifs, les mots et domaines exclus, la pondération et les règles par
  page. Reste `subCheckPolarity` (l'absence d'un sous-critère devient l'état
  conforme) : elle porte sur les SOUS-critères, que l'écran ne liste pas encore.
  Elle est conservée et réinjectée telle quelle.
- **Journal d'audit append-only en base** — l'absence de méthode `UPDATE`/`DELETE`
  est garantie côté applicatif et testée ; la verrouiller aussi par des droits
  MariaDB (`GRANT INSERT, SELECT` uniquement) serait plus robuste.
- **Corbeille des scans supprimés** — la v1 dispose d'une table `scan_archive`
  qui conserve les sessions supprimées en masse avant purge, avec restauration
  et export. Le module 3 livre les suppressions **sans** ce filet. La table
  existe et n'est pas touchée ; le module qui la réexpose reste à faire, et
  d'ici là une suppression est définitive — ce que l'interface annonce.
- **Suppressions depuis l'interface** — l'API expose les quatre portées (pages,
  session, site, domaine) et la suite sécurité les couvre ; l'interface ne les
  propose pas encore. Elles attendent la corbeille : offrir une suppression
  définitive d'un domaine entier en un clic, sans filet, serait imprudent.
