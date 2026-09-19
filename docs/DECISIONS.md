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

## 10. Profils par gamme : MariaDB, plus export fichier

**Décision** — La base est la source de vérité ; des endpoints d'export/import
JSON conservent le format fichier.

**Raison** — La v1 stockait un `settings-{gamme}.json` par gamme sur disque. Ce
modèle portait trois défauts :

1. Son verrouillage optimiste lisait la version, comparait, puis réécrivait —
   une **fenêtre de course** entre les deux. En base, la condition et l'incrément
   tiennent dans le même `UPDATE`, donc sont indivisibles.
2. Son cache TTL de 5 minutes servait des profils **périmés** derrière un
   répartiteur de charge : chaque instance avait sa propre vue du disque.
3. Le nom de gamme construisait un **chemin de fichier**. La traversée de chemin
   disparaît comme surface au lieu d'être contenue par une normalisation qu'il
   faudrait maintenir indéfiniment.

L'export/import préserve ce que le modèle fichier avait de bon : versionner un
profil dans Git, le rejouer d'un environnement à l'autre, l'inspecter hors ligne.

**Coût assumé** — Une table de plus, et un script d'import des fichiers existants
à écrire au moment de la bascule en production.

**Garde-fou** — Contrainte `CHECK (gamme REGEXP '^[a-z0-9-]+$')` en base, en plus
de la normalisation applicative : même un appelant qui contournerait le service
ne peut pas écrire une gamme hors de l'alphabet attendu.

---

## 11. Réglages globaux : une seule source de vérité

**Décision** — `/settings` opère sur le profil `default`. Les deux endpoints
restent exposés, mais s'appuient sur une seule ligne en base.

**Raison** — La v1 tenait `settings.json` ET `settings-default.json`, deux
fichiers remplissant le même rôle et pouvant diverger sans que rien ne le
signale. Un opérateur modifiant l'un pouvait constater que l'analyse continuait
d'appliquer l'autre.

**Coût assumé** — Si une installation v1 avait délibérément fait diverger les
deux fichiers, la bascule retient le profil `default`. À vérifier lors de la
migration ; en pratique les deux sont identiques.

---

## 12. Environnement : Node ≥ 22.22.3

**Décision** — Plancher relevé de 22.0.0 à 22.22.3.

**Raison** — Angular CLI 22 le refuse en deçà. Mieux vaut que l'installation
échoue immédiatement, avec un message clair, qu'au premier build.

---

## 13. Cap fonctionnel : la migration peut améliorer, pas seulement transcrire

**Décision** — Le port d'un module n'est pas tenu de reproduire les choix
fonctionnels de la v1 quand ils sont perfectibles. Corriger une logique métier
bancale, traiter un cas limite laissé de côté, ou moderniser un parcours
d'interface fait partie du travail de migration et ne nécessite pas d'accord
préalable module par module.

**Raison** — Recopier à l'identique un comportement dont on a constaté le défaut
pendant le port, c'est payer deux fois : une fois la recopie, une fois la
correction ultérieure — avec entre-temps une v2 qui hérite d'une dette qu'elle
n'avait aucune raison de contracter. Le moment où l'on relit une règle métier
ligne à ligne pour la porter est précisément celui où ses angles morts sont
visibles ; les laisser passer est un gâchis d'attention.

Trois améliorations de ce type sont déjà actées et documentées ici : la
révocation qui refuse au lieu de laisser passer (§8), l'unification des deux
fichiers de réglages divergents (§11), et le verrouillage optimiste des profils,
absent de la v1.

**Coût assumé** — La v2 cesse d'être comparable à la v1 ligne à ligne : une
différence de comportement n'est plus, en soi, la preuve d'un bug de migration.
C'est ce qui rend la règle suivante non négociable — **toute divergence
fonctionnelle assumée est consignée dans ce document**, avec sa raison et son
coût. Ce qui n'y figure pas et diffère de la v1 reste, lui, un bug.

**Garde-fous** — Aucune régression : ce que la v1 fait, la v2 le fait au minimum
(retirer une capacité n'est pas une amélioration, c'est un arbitrage qui se
discute avant). Améliorer n'est pas élargir : le périmètre demandé reste le
livrable, et une refonte large se propose plutôt qu'elle ne se code. Une
amélioration franchit exactement les mêmes portes que le reste — tests,
couverture, sécurité, lint, typecheck. Enfin, sur le périmètre sécurité, on
durcit, jamais on n'assouplit, et jamais sans test qui le prouve.

---

## 14. Historique des scans : la base v1 est reprise, pas recréée

**Décision** — Les tables `sites`, `scan_sessions` et `scan_pages` de la v1 sont
lues telles quelles. Le fichier `003-scan-history.sql` est à la fois une
création (base neuve) et une migration **additive** (base v1) : il n'ajoute
qu'une colonne, ne supprime ni ne renomme rien.

**Raison** — Ces tables tournent en production et contiennent l'historique réel.
Les recréer imposerait une reprise de données, une double écriture pendant la
bascule, ou une coupure — trois façons de payer cher un modèle qui, lui, est
sain : la normalisation site → session → page est exactement celle que la v2
aurait choisie. L'historique est ainsi utilisable dès le premier déploiement, et
une v1 et une v2 peuvent lire la même base pendant la transition, ce que le mode
« strangler » exige.

**Coût assumé** — La v2 hérite de conventions qu'elle n'a pas choisies : noms de
colonnes en `snake_case` anglais, dénormalisation de `gamme`/`epj` sur la
session, colonne générée `identity_key`. Aucune de ces décisions ne se rediscute
tant que la v1 lit la même base.

---

## 15. Rapport purgé : 410 Gone, et une colonne pour le savoir

**Décision** — Ajout de `scan_pages.report_purged_at`. Un rapport effacé par la
rétention donne un **410 Gone** portant la date de purge, là où un scan
inexistant donne un 404.

**Raison** — La v1 remettait `is_compressed = 0` et vidait les deux colonnes
après purge : la ligne devenait indiscernable d'une page qui n'a jamais eu de
rapport, et l'API répondait « scan introuvable ». C'est faux — le scan existe —
et c'est trompeur : l'utilisateur, puis le support, partent chercher une donnée
que l'application a elle-même supprimée. Un 410 dit que la donnée a existé,
qu'elle a été supprimée volontairement, et depuis quand.

**Coût assumé** — Une colonne de plus, et un code HTTP que les clients doivent
traiter. Les lignes déjà purgées par la v1 restent à `NULL` : elles se
comportent comme aujourd'hui (rapport indisponible, date inconnue) plutôt que de
se voir attribuer une date inventée.

---

## 16. Ingestion de l'historique : aucun endpoint HTTP

**Décision** — `ScansService.record()` est appelée **en process** par le module
d'analyse. Aucune route n'expose l'écriture de l'historique.

**Raison** — L'historique est une base de preuve : on s'y réfère pour dire ce
qu'était l'état d'un site à une date. Un endpoint d'ingestion offrirait à un
jeton volé — ou à un compte interne mal intentionné — le moyen de **fabriquer un
passé** : des audits qui n'ont jamais eu lieu, des scores qui n'ont jamais été
mesurés. Aucune validation d'entrée ne protège de cela, puisque la charge serait
parfaitement conforme. La seule défense est l'absence de porte.

**Coût assumé** — Un agent externe ne peut pas alimenter l'historique. Si le
besoin apparaît (sondes réparties, import de données tierces), il faudra une
route dédiée, authentifiée par un secret distinct du JWT utilisateur, et des
scans marqués comme provenant de l'extérieur — c'est-à-dire un arbitrage à part
entière, pas une extension de celui-ci.

**Garde-fou** — Un test de la suite sécurité vérifie qu'aucun `POST` sur
`/scans`, `/scans/ingest` ou `/scans/sessions` n'est routé.

---

## 17. Comparaison : les améliorations sont montrées, pas seulement les régressions

**Décision** — Le diff entre deux audits porte les dégradations **et** les
améliorations, les dégradations en tête.

**Raison** — La v1 ne remontait que les dégradations, pour éviter le bruit
pendant une analyse. Le raisonnement tenait dans ce contexte : on venait de
lancer un scan, on voulait savoir ce qui s'était cassé. Dans un écran
d'historique dont le sujet **est** l'évolution, il revient à ne montrer que la
moitié de l'information — et à laisser croire qu'un site ne progresse jamais,
alors même que l'équipe qualité vient de passer une semaine à le corriger.

Deux autres écarts avec la v1 suivent la même logique : une page disparue entre
deux audits est **signalée** au lieu d'être écartée (un site qui perd la moitié
de ses pages est un fait à montrer), et une page dont seul le score bouge —
pondération modifiée, statuts identiques — compte comme changée.

**Coût assumé** — Un diff plus volumineux, et un écran qui doit hiérarchiser au
lieu de tout aligner. Le tri fait ce travail : dégradations d'abord, puis delta
croissant, puis URL — un ordre total, donc reproductible d'un appel à l'autre.

---

## 18. Statistiques de l'historique : cache court plutôt que table d'agrégats

**Décision** — `GET /scans/stats` est servi depuis un cache mémoire d'une
minute, et limité à 20 appels par minute.

**Raison** — Le calcul balaie la table entière quatre fois. Sans cache, un
tableau de bord ouvert par trois personnes suffit à peser sur la base — et la
v1 n'imposait même pas de limite de débit sur cette route. Une table d'agrégats
entretenue à l'écriture serait plus efficace, mais introduirait un état à
maintenir cohérent à chaque suppression : un coût permanent pour un écran
consulté quelques fois par jour.

**Coût assumé** — Un chiffre peut avoir jusqu'à une minute de retard. Le cache
est invalidé à chaque suppression, qui est le seul évènement rendant les
chiffres faux d'un coup.

---

## 19. Isolation CPU : Piscina, avec repli en ligne obligatoire

**Décision** — Les analyses s'exécutent dans un pool Piscina dimensionné à un
thread de moins que de cœurs. Quand le pool ne peut pas démarrer, l'analyse se
fait **en ligne**, sur le thread principal.

**Raison** — Le parse du DOM d'une page de plusieurs centaines de kilo-octets
bloque la boucle d'événements assez longtemps pour retarder toutes les autres
requêtes servies. C'est le seul calcul lourd de l'application, et il est
parfaitement isolable : un analyseur ne touche ni la base ni l'état partagé.

Le repli n'est pas une commodité de test. Le produit cible des hébergements
mutualisés, où `worker_threads` peut être indisponible ou la mémoire contrainte.
Sur ces environnements, analyser lentement vaut mieux que ne pas analyser.

**Coût assumé** — Deux chemins d'exécution à maintenir, donc à tester tous les
deux. Le worker étant du JavaScript compilé, le chemin « pool » n'existe qu'après
`pnpm build` : la CI bâtit désormais le backend AVANT la suite de tests, sans
quoi le test du pool prendrait sa branche de repli et ne prouverait rien.

---

## 20. Le rapport d'analyse est décrit par un schéma, pas par une interface

**Décision** — `AnalysisReport` et tout ce qu'il contient sont des schémas Zod,
validés à la production comme à la relecture.

**Raison** — Ce rapport franchit trois frontières : la sérialisation vers un
worker, l'écriture en base, et la relecture des mois plus tard. Une interface
TypeScript ne survit à aucune des trois — elle disparaît à la compilation. À
chacune, une forme inattendue doit être détectée là où elle apparaît, et non
trois écrans plus loin sous la forme d'un champ manquant.

Le filtrage des en-têtes HTTP par **liste fermée** relève du même souci : un
rapport est stocké puis relu par des tiers, et y recopier tous les en-têtes
ferait entrer cookies, jetons de session et noms de serveurs internes sans que
personne ne l'ait décidé.

**Coût assumé** — Une validation supplémentaire par rapport produit. Le coût est
réel sur un lot de deux cents pages ; il reste inférieur à celui d'un rapport
corrompu stocké définitivement.

**Nuance** — L'historique (module 3) garde `report: z.unknown()` de son côté. Ce
n'est pas une incohérence : il restitue des rapports écrits par des versions
ANTÉRIEURES du moteur, et leur opposer le schéma courant rendrait illisibles les
scans déjà stockés.

---

## 21. Module 4 livré par l'architecture, pas par le nombre d'analyseurs

**Décision** — Le module 4 livre le pipeline complet (récupération SSRF-sûre,
profils, pool de threads, flux SSE, sitemap, historisation, suite sécurité) avec
**7 analyseurs sur les 29** de la v1. Les 22 restants suivent, sans changement de
structure.

**Raison** — Les analyseurs représentent près de 12 000 lignes en v1, et leur
port est un travail mécanique : ils ne posent aucune question d'architecture,
seulement du volume et des tests. Le pipeline, lui, tranche toutes les questions
difficiles — isolation CPU, sortie réseau, progression, assainissement des
erreurs hors filtre global, ordre de résolution des réglages. Livrer le pipeline
d'abord rend le port des analyseurs suivants purement additif : chacun est une
classe et un fichier de tests, sans effet sur le reste.

L'inverse aurait été pire : vingt-neuf analyseurs sans pipeline ne s'exécutent
nulle part, et les questions difficiles se seraient posées à la fin, quand les
reprendre coûte le plus cher.

**Coût assumé** — Le rapport produit est PARTIEL, et le score global ne porte que
sur les critères présents. Il n'est donc pas comparable à un score v1, et le
module ne peut pas basculer en production tant que les 29 ne sont pas là. C'est
une dette explicite, listée critère par critère dans `ARCHITECTURE.md`.

---

## 22. Le rapport d'analyse se lit en trois niveaux, pas en une liste

**Décision** — L'écran `/analyse` ne reproduit pas la liste plate de la v1, où
les vingt-neuf critères sont affichés au même rang visuel. Il hiérarchise :
score, verdict et trois corrections prioritaires d'abord ; critères groupés et
**filtrés sur « à traiter »** ensuite ; occurrences et recommandations au dépli
d'un critère. C'est une divergence fonctionnelle assumée vis-à-vis de la v1, au
sens de `CLAUDE.md` §1.

**Raison** — Un rapport dont vingt-cinq lignes sur vingt-neuf sont vertes
apprend à l'équipe à le survoler, et qui le survole rate aussi les quatre
rouges. Le tri des corrections prioritaires par gravité puis par **poids du
critère** répond à la même logique : deux échecs ne coûtent pas le même score,
et l'écran doit dire lequel traiter d'abord plutôt que laisser l'auditeur le
recalculer. Les critères de poids nul en sont exclus — corriger ce qui ne pèse
rien sur le score n'est pas une priorité.

**Aucune régression** — Rien n'est retiré : l'intégralité du rapport reste
atteignable, en un clic sur le filtre « tout afficher », et le nombre de
critères masqués est affiché en permanence. Le masquage par défaut ne devient
jamais un masquage implicite.

**Coût assumé** — Trois coûts, tous acceptés :

1. **Un geste de plus pour la lecture exhaustive.** Un auditeur qui veut relire
   les vingt-neuf critères doit changer de filtre. C'est le prix de l'inversion :
   le cas fréquent (« qu'est-ce qui ne va pas ? ») coûte zéro geste, le cas rare
   en coûte un.
2. **Une logique de présentation à tester pour elle-même.** Priorisation,
   groupement, filtrage et comptes masqués sont du code, donc des bugs
   possibles — d'où `report-view.ts` en fonctions pures testées à part, plutôt
   que des expressions dispersées dans les gabarits.
3. **Un écart de vocabulaire avec la v1.** Le « verdict » et les « corrections
   prioritaires » n'existent pas en v1 ; une équipe habituée à l'ancien écran
   doit relier les deux vues. Les libellés de critères, eux, sont inchangés.

**Corollaire technique** — Le flux passe par `fetch` + `ReadableStream` plutôt
que par `EventSource`, qui ne sait faire que du GET et exposerait l'URL auditée
dans une barre d'adresse et dans les journaux des proxys. Coût : la reconnexion
automatique d'`EventSource` est perdue. Un flux interrompu avant la fin est donc
signalé explicitement, avec proposition de relance, plutôt que repris en
silence — ce qui vaut mieux qu'une reprise invisible qui relancerait une analyse
complète à l'insu de l'utilisateur.
