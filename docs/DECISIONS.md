# Arbitrages techniques — WebSentry v2

Ce document tranche les points laissés ouverts par le cahier des charges, et
consigne les décisions prises en cours de route quand la réalité de la stack a
imposé un écart. Chaque entrée indique la décision, sa raison, et ce qu'elle
coûte — un arbitrage sans coût énoncé est un arbitrage mal instruit.

---

## 1. Accès MariaDB : repository `mysql2` plutôt que TypeORM

**Décision** — Repository pattern natif sur `mysql2/promise`, requêtes SQL
écrites à la main et systématiquement paramétrées.

**Raison** — Le schéma v1 existe, est en production et est finement ouvragé :
contraintes `CHECK`, `ENUM`, colonnes `JSON`, index composés, commentaires de
table. Une approche entité-d'abord (TypeORM) obligerait soit à décrire ce schéma
en décorateurs — exercice de recopie sans valeur ajoutée et source de dérive —
soit à le synchroniser dans le mauvais sens. Le SQL reste par ailleurs lisible et
auditable tel quel, ce qui compte pour un périmètre où l'injection SQL est un
risque suivi.

S'y ajoute une considération de surface : TypeORM apporte plusieurs milliers de
lignes de dépendances transitives à maintenir sous veille CVE, pour un besoin
— du CRUD sur une dizaine de tables — que `mysql2` couvre déjà.

**Coût assumé** — Pas de migrations formelles générées : elles restent des
fichiers `.sql` versionnés, appliqués explicitement. Pas de portabilité vers un
autre SGBD ; ce n'est pas un objectif du produit.

**Garde-fou** — `DatabaseService.query/queryOne/execute` n'acceptent que
`(sql, params)` avec un type `SqlParam` étroit (scalaires uniquement). Passer un
objet arbitraire issu d'un corps de requête ne compile pas. Chaque repository a
un test vérifiant que la valeur d'entrée part en paramètre et non dans le texte
de la requête.

---

## 2. Génération PDF : côté serveur (`pdfmake` dans Nest)

**Décision** — Génération serveur, au module 4 (analyse). _Non implémenté à ce
stade — décision prise pour orienter la conception, pas encore du code._

**Raison** — Un rapport d'audit est un document contractuel, parfois transmis à
un client final : sa mise en page doit être identique quel que soit le navigateur
qui l'a demandé. Une génération client dépend des polices installées, du moteur
de rendu et de la mémoire de l'appareil. Côté serveur, le rendu est reproductible
et peut être régénéré à l'identique depuis l'historique des scans.

**Coût assumé** — Charge CPU sur l'API (à isoler dans un worker Piscina, comme
les analyseurs) et un aller-retour réseau supplémentaire.

---

## 3. Tests : Vitest partout, Jest écarté

**Décision** — Vitest côté backend ET côté frontend. Angular Testing Library pour
les composants. Playwright pour les E2E navigateur.

**Raison — backend** : le cahier des charges recommandait Jest, « défaut natif
Nest ». Cette recommandation ne tient plus avec **Nest 12, qui n'est distribué
qu'en ESM** (`"type": "module"`, aucun export CommonJS). La chaîne Jest + ts-jest
en ESM reste expérimentale : elle exige `--experimental-vm-modules`, et les mocks
partiels y sont fragiles. Vitest est nativement ESM, et `@nestjs/testing`
fonctionne identiquement avec lui — c'est le conteneur d'injection de Nest qui
fait le travail de mocking, pas le lanceur de tests.

Point d'attention : la transformation passe par **SWC et non esbuild**, car
esbuild n'implémente pas `emitDecoratorMetadata`, dont dépend l'injection par
type de Nest. Sans lui, tout `constructor(private readonly x: Service)` recevrait
`undefined`.

**Raison — frontend** : Karma est déprécié depuis Angular 16. Testing Library
oriente les tests vers ce que l'utilisateur perçoit — rôles, libellés — plutôt
que vers la structure interne des composants, qui change à chaque refonte.

**Bénéfice de bord** — Vitest s'appuie sur Vite, ce qui aligne l'outillage de test
sur la préférence habituelle du parc (voir §5).

**Coût assumé** — Écart documenté par rapport à la recommandation initiale ; une
dépendance de plus (`unplugin-swc`) côté backend.

---

## 4. E2E : Playwright plutôt que Cypress

**Décision** — Playwright.

**Raison** — Cypress exécute ses tests **dans** la page. Or toute
l'authentification de WebSentry repose sur des cookies `httpOnly`, précisément
invisibles depuis la page : un test Cypress ne pourrait pas vérifier qu'ils sont
correctement posés, ni qu'aucun jeton ne fuit vers `document.cookie`. Playwright
pilote le navigateur de l'extérieur et accède au magasin de cookies complet.
S'y ajoutent l'attente automatique et un parallélisme réel.

**Coût assumé** — Aucun significatif ; l'écosystème de plugins Cypress n'est pas
utilisé ici.

---

## 5. Build : Nest CLI et Angular CLI, Vite en sous-outillage

**Décision** — `tsc` (backend) et le builder `@angular/build` fondé sur esbuild
(frontend) pilotent les builds. Vite n'orchestre pas la construction.

**Raison** — C'est un **écart assumé** par rapport à la préférence habituelle pour
Vite. Angular n'utilise pas Vite pour ses builds de production : son builder
officiel repose sur esbuild, avec des performances équivalentes et, surtout, la
seule chaîne qui comprenne la compilation des templates et le compilateur AOT.
Imposer Vite ici signifierait sortir du chemin supporté par Angular, pour un gain
nul.

**Compensation** — Vite est bien présent, là où il apporte quelque chose : c'est
le moteur de **Vitest**, utilisé pour l'intégralité des tests unitaires des trois
paquets. L'homogénéité d'outillage recherchée est donc obtenue sur la boucle de
développement, sans sacrifier la chaîne de build officielle.

---

## 6. Validation : Standard Schema natif, `nestjs-zod` écarté

**Décision** — Les schémas Zod partagés sont passés directement aux décorateurs
Nest (`@Body({ schema: LoginSchema })`), validés par le
`StandardSchemaValidationPipe` intégré à Nest 12.

**Raison** — Le cahier des charges prévoyait `nestjs-zod`. Entre-temps, **Nest 12
intègre nativement le support de Standard Schema**, que Zod 4 implémente. La
couche d'adaptation tierce est donc devenue inutile — et elle ne déclarait de
toute façon pas Nest 12 comme pair compatible (`^10 || ^11`), ce qui aurait
introduit un conflit de dépendances et un risque de rupture à chaque montée.

**Bénéfice** — Une dépendance de moins sous veille CVE, et un chemin de code plus
court entre le schéma et la validation.

`class-validator` est écarté pour la même raison de fond : **un seul moteur de
validation**. Deux jeux de règles parallèles finissent toujours par diverger, et
c'est l'écart entre les deux qui devient la faille.

---

## 7. Format de module : API en ESM

**Décision** — `apps/api` est un paquet ESM (`"type": "module"`), imports relatifs
suffixés `.js`.

**Raison** — Contrainte, pas préférence : **Nest 12 ne publie plus de build
CommonJS**. Un backend CommonJS ne peut pas `require()` ses propres dépendances
framework.

**Conséquence** — `@websentry/shared` produit une **double sortie** ESM et CJS :
le frontend consomme la variante ESM (le bundler peut alors éliminer le code
mort), et la variante CJS reste disponible pour tout consommateur Node hérité.

---

## 8. Révocation en cas de panne : refuser plutôt que laisser passer

**Décision** — Quand la base est injoignable, la vérification de `token_version`
**refuse** l'accès (503) au lieu de laisser passer.

**Raison** — La v1 se repliait sur « ne pas bloquer l'authentification » si la
base ne répondait pas. Cette tolérance rend la révocation **contournable** : il
suffit de faire tomber la base pour que des jetons révoqués redeviennent valides.
Une panne doit dégrader la **disponibilité**, jamais l'**autorisation**.

**Coût assumé** — Une indisponibilité de la base devient une indisponibilité de
l'API authentifiée. C'est le comportement attendu : sans base, l'API n'a de toute
façon aucune donnée à servir.

**Exception délibérée** — Le super_admin (rang 100) court-circuite la résolution
des permissions fines sans requête en base. Le compte de dernier recours ne doit
pas pouvoir être enfermé dehors par une panne.

---

## 9. Environnement : Node ≥ 22.22.3

**Décision** — Plancher relevé de 22.0.0 à 22.22.3.

**Raison** — Angular CLI 22 le refuse en deçà. Mieux vaut que l'installation
échoue immédiatement, avec un message clair, qu'au premier build.
