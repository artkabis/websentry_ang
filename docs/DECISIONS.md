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

**Dette soldée** — Les 29 analyseurs sont portés. Le pari tient : aucun n'a
demandé de changement de structure, la seule capacité ajoutée au pipeline étant
la sonde réseau du §23. Les écarts de score vis-à-vis de la v1 qui subsistent
sont des corrections assumées, décrites au §25.

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

**Corollaire — l'écran est partageable.** L'adresse analysée et le filtre sont
portés par l'URL. Un rapport s'envoie donc par lien et survit à un
rafraîchissement, et le filtre choisi voyage avec : montrer « tout » à un
collègue ne demande pas de lui expliquer où cliquer. L'écriture remplace
l'entrée d'historique au lieu d'en empiler une par clic.

**Corollaire technique** — Le flux passe par `fetch` + `ReadableStream` plutôt
que par `EventSource`, qui ne sait faire que du GET et exposerait l'URL auditée
dans une barre d'adresse et dans les journaux des proxys. Coût : la reconnexion
automatique d'`EventSource` est perdue. Un flux interrompu avant la fin est donc
signalé explicitement, avec proposition de relance, plutôt que repris en
silence — ce qui vaut mieux qu'une reprise invisible qui relancerait une analyse
complète à l'insu de l'utilisateur.

---

## 23. Une seule porte de sortie réseau : la sonde, jamais `fetch`

**Décision** — Aucun analyseur n'appelle `fetch`. Six critères ont besoin du
réseau (`ROBOTS_META`, `IMAGES`, `BROKEN_LINKS`, `MENTIONS_LEGALES`, et par
ricochet la vérification des ressources qu'ils citent) ; tous reçoivent une
`NetworkProbe` construite sur la politique SSRF **reconstituée dans le worker**.
La sonde ne lève jamais d'exception, décrémente un budget de requêtes AVANT
chaque appel, borne la concurrence et partage un cache TTL/LRU sur la durée de
l'analyse.

**Raison** — Un worker n'a pas de conteneur Nest : sans cette reconstitution,
la tentation est d'y appeler `fetch` directement, et la garde SSRF devient
décorative sur le seul chemin qui émet réellement des requêtes. Le budget est
décrémenté avant l'appel et non après, parce qu'une page hostile qui déclare
dix mille images ne doit pas pouvoir transformer WebSentry en amplificateur —
compter après coup laisserait passer la rafale avant de la mesurer. Et une
sonde qui lève transformerait un lien injoignable — c'est-à-dire un RÉSULTAT
d'analyse — en panne d'analyse.

**Durcissements par rapport à la v1**, tous couverts par des tests :

- le repli HEAD → GET couvre `403`, `405` et `501`, là où la v1 ne réessayait
  que sur `405` : beaucoup de serveurs répondent 403 ou 501 à un HEAD légitime,
  et la v1 comptait ces URL comme cassées ;
- un `Content-Length` non numérique rend `null` au lieu de propager un `NaN`
  jusque dans le rapport ;
- le message d'échec est choisi **par type d'erreur** et jamais recopié depuis
  l'exception : une page ne dicte pas le texte d'un rapport.

**Coût assumé** — Deux coûts. D'abord un budget qui peut être atteint : sur une
page qui cite plus d'URL que le budget ne le permet, les dernières ne sont pas
vérifiées, et le rapport doit le dire plutôt que de les déclarer saines. Ensuite
une indirection de plus à l'écriture d'un analyseur : la sonde se passe en
paramètre, ce qui est précisément ce qui rend ces analyseurs testables sans
réseau.

---

## 24. Le contraste se mesure sans navigateur

**Décision** — `CONTRAST_V2` est porté avec un micro-moteur CSS embarqué
(`analysis/css/`) : cascade, spécificité, héritage, custom properties,
`@media`/`@layer`/`@supports`/`@container`, puis un résolveur de fond effectif
qui compose les couches semi-transparentes et remonte les ancêtres. Pas de
navigateur sans tête dans le pipeline d'analyse.

**Raison** — Le contraste ne se lit pas dans le HTML. L'alternative était un
Chromium par page analysée : plusieurs centaines de mégaoctets de mémoire et
une à deux secondes par page, dans un worker qui en traite des dizaines. Le
moteur est vendu avec son périmètre : il suit **neuf propriétés**, pas la
feuille de style entière.

**Écarts fonctionnels assumés vis-à-vis de la v1** :

1. **Les défauts sont groupés** par paire de couleurs et par seuil de taille,
   et le libellé d'un groupe ne porte pas son décompte — sans quoi un même
   défaut serait compté comme plusieurs d'une page à l'autre.
2. **Un dégradé est mesuré** sur son pire arrêt de couleur au lieu d'être
   renvoyé à une vérification manuelle. Seuls les fonds en image et les
   empilements de couches restent « à vérifier à l'œil ».
3. **Un thème sombre déclaré** bascule le fond par défaut sur le noir : sinon
   un texte clair parfaitement lisible serait rapporté illisible.

**Coût assumé** — Trois coûts. Un moteur CSS de ~2 200 lignes est du code à
maintenir, et il dérivera des navigateurs à mesure que CSS avance ; c'est pour
cela qu'il est testé pour lui-même et non seulement à travers l'analyseur. Les
**feuilles externes ne sont pas chargées** : un site dont toute la charte tient
dans un `.css` distant est mesuré sur des valeurs par défaut (dette inscrite
dans `ARCHITECTURE.md`). Enfin, aucune mise en page n'est calculée : un texte
masqué par un recouvrement est mesuré comme s'il était visible.

---

## 25. Les défauts de logique de la v1 sont corrigés au passage, pas recopiés

**Décision** — Le port des 29 analyseurs applique `CLAUDE.md` §1 : là où le
portage met au jour une règle bancale, elle est corrigée et la correction est
couverte par un test qui échoue si on la retire. Une vingtaine de divergences,
dont deux de sécurité :

- **Injection de sélecteur** — `ACCESSIBILITY` construisait
  `label[for="${id}"]` à partir d'un identifiant venu de la page analysée ; un
  `id` contenant un guillemet cassait le sélecteur, donc le critère entier, sur
  une valeur que l'auteur de la page contrôle. Les `label[for]` sont désormais
  indexés une fois. `MENTIONS_LEGALES_DATA` souffrait du même défaut.
- **Comparaisons trop larges** — `links` excluait un domaine par
  `url.includes(domaine)` (un profil excluant `mappy.com` excluait aussi
  `notmappy.com.example`), `CTA` testait l'inclusion brute d'un mot (« voir »
  se trouve dans « savoir »), `PICTOGRAM` filtrait des classes en sous-chaîne.
  Tous comparent maintenant des jetons ou des domaines entiers.
- **Cas limites non traités** — `STRUCTURED_DATA` ignorait un document
  `@graph`, pourtant la forme la plus courante ; `FAVICON` appelait
  `new URL(href)` sans base, donc échouait sur un chemin relatif ; `TRACKING`
  cherchait ses motifs dans le document entier et voyait un consentement là où
  il n'y avait qu'un lien ; `DATA_BINDING` enchaînait deux recherches avec
  `||`, opérateur qu'une sélection Cheerio vide satisfait.

**Aucune régression** — Chaque correction a été vérifiée dans le sens du
portage : le comportement v1 reste obtenu sur les cas que la v1 traitait
correctement ; seuls les cas qu'elle traitait mal changent de verdict.

**Coût assumé** — Deux coûts, acceptés. Un **score non identique** à celui de
la v1 sur les pages qui déclenchaient ces défauts : une comparaison v1/v2 sur
un même site montrera des écarts, qui sont des corrections et non des
régressions — il faut pouvoir le dire à l'équipe qualité, d'où cet arbitrage.
Et un **coût de relecture** : chaque divergence est portée par un commentaire
qui dit ce que faisait la v1 et pourquoi la v2 fait autrement, sans quoi la
prochaine lecture du code prendrait la correction pour une erreur de portage.

---

## 26. Le budget réseau est réparti à l'avance, critère par critère

**Décision** — Les requêtes sortantes d'une analyse ne sont plus une enveloppe
commune servie au premier qui la demande : chaque critère reçoit un quota fixé
d'avance (`CHECK_QUOTAS`), et l'orchestrateur lui donne une vue de sonde qui ne
dépasse pas ce quota. Le plafond global subsiste, mais comme garde-fou, pas
comme mode de répartition. Un dépassement produit un état distinct
(`exhausted`), que les quatre critères réseau annoncent en note d'information
sans le compter comme un défaut du site.

**Raison** — Les analyseurs partent ensemble, et la somme de ce qu'ils veulent
vérifier dépasse le plafond d'une analyse. Avec une enveloppe commune, le
partage se décidait donc par l'ordonnancement : deux analyses de la même page
pouvaient rendre deux rapports différents, l'une ayant pesé les images, l'autre
vérifié les liens. **Un audit qui bouge d'une exécution à l'autre n'est pas un
audit** — c'est un défaut de correction, pas une question de performance.

Quant au dépassement, le confondre avec un échec revenait à reprocher au site
une limite que nous nous imposons : un lien jamais interrogé était rapporté
« injoignable », et la note du critère baissait.

**Aucune régression** — Les seuils par critère sont au-dessus de ce qu'une page
ordinaire demande, et une réponse déjà connue ne consomme rien : sur un lot, la
deuxième page et les suivantes retrouvent leur quota intact pour ce qu'elles
ont de propre.

**Coût assumé** — Deux coûts. D'abord une **table à tenir** : ajouter un critère
réseau sans lui donner de quota lui laisse le minimum, et la somme des quotas
doit rester sous le plafond — c'est une contrainte de plus à la revue. Ensuite,
sur une page très fournie, un critère peut atteindre son quota alors que le
plafond global n'est pas épuisé : le rapport annonce alors des liens non
vérifiés là où une enveloppe commune en aurait vérifié davantage — mais sans
garantir lesquels d'une exécution à l'autre.

---

## 27. Une ressource déjà vue ne se revérifie pas

**Décision** — Le moteur de sortie réseau vit dans le **processus principal**,
et les threads d'analyse lui adressent leurs demandes par un canal. Il
mémorise chaque URL, partage les requêtes déjà en vol, dédoublonne les listes
qu'on lui donne, et borne la concurrence pour le processus entier.

**Raison** — Le menu et le pied de page d'un site sont les mêmes sur toutes ses
pages : sur un scan de sitemap de deux cents pages, les vérifier page par page
multiplie par deux cents une information qui n'a pas changé. Le cache existait
déjà, mais il était **dans le thread** : un pool de huit threads le fragmentait
en huit, et le même lien repartait huit fois. C'est du réseau dépensé pour
rien, et surtout une charge infligée au site audité que l'audit n'exige pas.

**Aucune régression** — La politique SSRF n'est ni contournée ni assouplie :
elle s'applique désormais au même endroit pour tous les chemins d'exécution,
là où elle était reconstruite dans chaque thread. Un échec de canal rend un
résultat « sortie réseau indisponible », non facturé et non confondu avec un
quota atteint.

**Corollaire** — La même règle vaut un cran plus haut : un lot n'analyse
qu'une fois une URL répétée. Un sitemap qui cite deux fois la même page ne
décrit qu'une page, et le total annoncé porte donc sur les pages réellement
distinctes — gonfler le compte d'un travail qui n'a pas eu lieu serait un
mensonge par arrondi.

**Coût assumé** — Trois coûts. Les requêtes sortantes reviennent sur la **boucle
d'événements principale** : c'est de l'attente réseau et non du calcul — ce que
le thread isole, le parse du DOM, y reste — mais la lecture d'un corps borné
(512 Ko) s'y décode désormais. Ensuite, un **canal de plus par tâche**, donc un
cycle de vie à tenir : un thread arrêté en pleine requête doit voir ses attentes
dénouées, sans quoi l'analyse resterait suspendue. Enfin, un résultat mémorisé
**vieillit** : dix minutes pour un succès, une pour un échec — un lien réparé
pendant un scan peut donc être encore rapporté cassé jusqu'à la fin du scan.

---

## 28. La reconnaissance de zone se fait sur les attributs, pas par sélecteurs

**Décision** — Le module qui décide de la zone d'un lien (menu, pied de page,
contenu, CTA, boutique…) n'utilise plus de sélecteurs CSS. Les mêmes règles sont
exprimées en tests d'attributs : balise, `role`, sous-chaîne de `class`, jeton de
`class` exact, `id`.

**Raison** — Un `node.is('…')` reparse et recompile sa chaîne à CHAQUE appel.
Le profilage du critère des liens sur une page de 185 liens montrait un quart du
temps passé dans l'analyseur de sélecteurs de Cheerio — pour reconnaître huit
familles de conteneurs dont les règles tiennent en quelques comparaisons de
chaînes. C'est du travail refait des milliers de fois par page.

**Aucune régression** — Un test DIFFÉRENTIEL garde les sélecteurs d'origine
comme implémentation de référence et compare les deux verdicts cas par cas, sur
une table qui couvre chaque règle et les pièges documentés — dont le jeton
`dmContent`, qui ne doit PAS attraper les `dmContentSlot` que l'éditeur place
dans l'en-tête et le pied de page.

**Portée** — La règle vaut pour tout le moteur, pas pour la seule lecture de
zone : conteneurs de navigation du maillage, zones de la concordance d'ancres,
sélecteurs d'exclusion d'un profil (appliqués une fois à la page plutôt que lien
par lien), recherche d'image dans un lien. Le parcours commun vit dans
`dom-walk.ts`.

**Coût assumé** — Les règles ne sont plus lisibles d'un seul coup d'œil sous
forme de sélecteur : ajouter une convention de classe demande de toucher un
prédicat plutôt qu'une chaîne. Le test différentiel rend cette modification sûre,
mais il faut penser à y ajouter le cas. En contrepartie, la sémantique est
désormais explicite là où un `[class*="…"]` cachait une correspondance par
sous-chaîne que personne ne lisait comme telle.

---

## 29. L'inversion de polarité DÉPLACE la note, elle ne la remplace plus

**Décision** — Quand un sous-critère est inversé pour une gamme (la présence
d'un formulaire est souhaitable ici, indésirable là), la note du critère n'est
plus recalculée sur une échelle générique : on mesure l'écart que l'inversion
provoque sur cette échelle commune, et on l'applique à la note rendue par
l'analyseur.

**Raison** — Chaque analyseur a son barème : le contraste note une PROPORTION de
textes conformes, d'autres comptent des manques par palier. Remplacer cette note
par une échelle générique parce qu'un seul sous-critère est inversé jetait le
travail du barème et rendait deux gammes incomparables — la même page, auditée
sous deux profils, ne différait plus seulement sur le sous-critère inversé mais
sur toute la note du critère.

**Aucune régression** — Le sens de l'inversion est conservé : créer un échec
fait chuter la note, en lever un la fait monter, et la note reste bornée à
l'échelle 0–5 du rapport.

**Coût assumé** — L'écart est mesuré sur une échelle qui n'est pas celle de
l'analyseur : sur un critère au barème très resserré, un déplacement de deux
points peut saturer la note à 5 ou à 0. C'est un arrondi assumé, et il reste
très préférable à la perte complète du barème.

---

## 30. Une URL refusée par la politique SSRF est une demande irrecevable, pas une panne

**Décision** — Un refus de la garde SSRF rend **422 Unprocessable Entity** et le
motif en clair : « cette URL ne peut pas être analysée : elle cible une adresse
non publique ». La phrase vit à côté de l'erreur, et les quatre chemins — page,
lot, flux, sitemap — l'emploient telle quelle. La lecture d'un sitemap ne
répond plus « aucune URL trouvée » à une adresse interne : le refus remonte.

**Raison** — Le refus sortait en **500**, avec « une erreur interne est
survenue ». Deux dégâts : l'appelant croyait à une avarie passagère et
réessayait, et chaque refus s'inscrivait au journal des incidents serveur, où
il masquait les vraies pannes. Le flux SSE, lui, disait déjà le motif
franchement — la même cause s'expliquait donc de deux façons selon la route.

Ces défauts vivaient derrière un angle mort de la couverture : la suite E2E
remplaçait la récupération de page par un double, si bien que la garde SSRF
n'était éprouvée par AUCUN test passant par HTTP. Seul le refus de protocole
l'était, et il tient au schéma, avant toute connexion.

**Aucune régression** — La politique n'est ni assouplie ni contournée : ce sont
le statut et le libellé qui changent. Le message ne cite toujours ni l'adresse
résolue ni la plage bloquée — les connaître aiderait à cartographier le réseau
interne, et un test le vérifie.

**Coût assumé** — Les suites E2E peuvent désormais monter la VRAIE récupération
de page (`realPageFetcher`). C'est une porte vers un test qui sortirait sur
Internet : elle est réservée aux adresses refusées avant toute connexion, et
l'option le dit à l'endroit où on la lit. Un test qui viserait un hôte public
ferait sortir la suite — la contrainte est documentée, pas mécanique.

---

## 31. Le contraste lit les feuilles de style externes — par la sonde, et il dit ce qu'il n'a pas lu

**Décision** — `CONTRAST_V2` mesure désormais aussi les règles portées par les
feuilles `<link rel="stylesheet">`. Le micro-moteur CSS ne gagne pas pour autant
de porte de sortie : il reçoit une **fonction de lecture** ou rien, et c'est
l'analyseur qui la construit sur la sonde réseau. Trois bornes l'encadrent : la
politique SSRF, un plafond de 512 Kio par feuille, et un quota de huit requêtes
par page (`CHECK_QUOTAS.CONTRAST_V2`), les feuilles étant lues dans l'ordre du
document. Ce qui est **déclaré** et ce qui a été **lu** sont comptés séparément,
et tout écart devient un item `info` du rapport.

**Raison** — La v2 évaluait les seuls styles embarqués et en ligne. Sur un site
dont la charte tient dans un `.css` distant — c'est-à-dire la quasi-totalité des
sites — le critère mesurait du noir sur blanc par défaut et rendait un « pass »
qui ne portait sur rien. Un verdict rendu sans avoir vu les couleurs de la page
est pire qu'une absence de verdict : il rassure.

**Aucune régression** — Sans sonde, le comportement est exactement l'ancien :
styles embarqués et en ligne, rien de plus. La différence est qu'il est
désormais **annoncé** au lieu d'être tu. Le moteur reste testable sans réseau,
et la seule porte de sortie du système demeure la sonde.

**Coût assumé** — Jusqu'à huit requêtes sortantes de plus par page analysée,
prises sur le budget global (300). Sur un lot, le cache du moteur de sonde les
absorbe presque entièrement : la charte d'un site est la même d'une page à
l'autre, donc lue une seule fois et remboursée ensuite. Deuxième coût : au-delà
de huit feuilles déclarées, ou au-delà de 512 Kio, la mesure est partielle — le
rapport le dit, il ne le devine pas. Troisième coût : le temps d'analyse d'une
page isolée augmente de la latence de ses feuilles, bornée par le délai de la
sonde.

---

## 32. Le paquet partagé se déclare sans effet de bord — et l'import de Zod suit une forme imposée

**Décision** — Les dossiers de sortie de `@websentry/shared` portent
`sideEffects: false`, et ses modules importent Zod par espace de noms
(`import * as z from 'zod'`), forme rendue obligatoire par une règle ESLint. Le
budget de bundle initial passe de 800 kio (avertissement) / 1 Mio (erreur) à
440 / 480 kio.

**Raison** — Le chargement initial pesait 804,84 kio bruts pour 173,74 kio
transférés, dont **498 kio de Zod** : 290 kio de traductions — quarante langues
que rien n'appelle — et 38 kio de conversion JSON Schema. L'import nommé rend
un objet d'espace de noms qu'esbuild ne sait pas élaguer ; l'import par espace
de noms lui laisse résoudre chaque accès vers l'export concerné. Restait le
catalogue des vingt-neuf critères, 46 kio lus par les seuls écrans différés mais
embarqués d'emblée, faute de `sideEffects` là où le bundler le cherche —
c'est-à-dire dans le package.json du dossier de sortie, pas dans celui du
paquet. Résultat : **423,00 kio bruts, 112,74 kio transférés**, soit 47 % et
35 % de moins.

**Aucune régression** — Aucun code applicatif ne change : `z.object(…)` s'écrit
et se comporte comme avant. Les 2 491 tests unitaires passent à l'identique, et
les 35 scénarios Playwright ont été rejoués **contre le bundle de production**
servi en statique — pas contre le serveur de développement — précisément parce
que c'est l'élagage qui était en cause.

**Coût assumé** — `sideEffects: false` est une **affirmation** : elle promet
qu'aucun module du paquet ne fait quoi que ce soit à l'import. C'est vrai
aujourd'hui — schémas, constantes, fonctions pures — et rien ne le vérifie
mécaniquement. Un module qui enregistrerait un format global, configurerait la
locale de Zod ou muterait un registre au chargement serait **silencieusement
écarté** du bundle : pas d'erreur, juste un comportement absent en production et
présent en test. La contrainte est écrite ici et en tête du script qui produit
ces fichiers. Second coût : le budget resserré refusera un build qui dépasse
480 kio — ce qui est l'effet recherché, mais demandera d'instruire tout ajout
lourd au lieu de le laisser passer.

---

## 33. Une feuille de style n'est découpée qu'une fois par worker

**Décision** — Le micro-moteur CSS mémorise le découpage d'une feuille par le
**texte** de celle-ci, ainsi que tout ce qui n'en dépend que : liste de
sélecteurs éclatée, spécificité de chacun, clé d'index, variables de palette.
Le cache est borné à 4 Mio de source par thread, avec éviction par ancienneté.
Ce qui dépend de la page — filtrage `@media`, mise en correspondance avec le
document — reste rejoué à chaque page.

**Raison** — Le téléchargement d'une charte était déjà mutualisé par le moteur
de sonde ; son **découpage** ne l'était pas. Sur une page portant une feuille de
287 Kio, le critère de contraste coûtait 24,4 ms, dont 23,1 de reconstruction du
CSSOM — pour un résultat rigoureusement identique d'une page à l'autre, puisque
la charte ne change pas. Sur un lot de deux cents pages, c'était près de cinq
secondes de travail répété par thread. La feuille de l'agent utilisateur,
constante, était elle aussi redécoupée à chaque page. Mesure après : **5,0 ms**
par page avec charte externe, 3,8 ms pour la seule construction du CSSOM.

**Aucune régression** — Les verdicts sont inchangés : 163 tests du moteur CSS et
du résolveur de contraste passent à l'identique, et quatre mutations vérifient
que les propriétés neuves sont réellement tenues — filet des couches anonymes,
ordre des couches nommées rejoué à chaque réutilisation, palette non versée par
une règle écartée par le viewport, règles partagées non modifiables.

**Coût assumé** — Trois. D'abord la mémoire : jusqu'à 4 Mio de source CSS et les
règles correspondantes par thread, gardées jusqu'à éviction ; c'est un plafond
choisi, pas une conséquence subie. Ensuite le partage : les règles mémorisées
sont vues par toutes les pages, donc figées (`Readonly` au compilateur,
`Object.freeze` à l'exécution) — une écriture en place lève désormais au lieu de
contaminer silencieusement les pages suivantes, mais tout code futur qui voudrait
enrichir une règle devra la recopier. Enfin les couches `@layer` **anonymes**,
dont le nom dépend d'un compteur de page : ces feuilles ne sont pas mémorisées et
gardent le coût d'un découpage par page. Elles sont rares ; le contraire aurait
été de fusionner deux couches distinctes, ce qui change des verdicts.

---

## 34. Le thème s'écrit une fois, avec `light-dark()` — et les jetons nomment des rôles, jamais des teintes

**Décision** — Les gabarits n'emploient plus de couleur de palette (`bg-white`,
`text-slate-500`, `bg-red-50`) mais des jetons de RÔLE : `panel`, `content-subtle`,
`danger-surface`. Chaque jeton est défini une seule fois sous la forme
`light-dark(clair, sombre)` ; le thème est choisi par `color-scheme` sur la
racine, forcé au besoin par `data-theme="clair"` ou `"sombre"`. Trois
préférences : clair, sombre, et **système** — l'absence de choix.

**Raison** — Le cap UX (`CLAUDE.md` §2) demande le thème sombre dès la
conception, et la dette s'alourdissait à chaque écran. Quatre cent soixante-dix
classes de palette étaient dispersées dans dix-huit gabarits : chacune fige une
teinte claire, et aucune ne peut répondre à un fond sombre. Le détour par les
rôles était de toute façon exigé — « des jetons définis une fois et réutilisés,
pas de valeurs arbitraires dispersées dans les gabarits ».

`light-dark()` plutôt qu'un doublon sous `@media (prefers-color-scheme: dark)` :
une valeur, un endroit, aucune chance que les deux blocs divergent. Et surtout,
la préférence du système s'applique **avant** que le JavaScript démarre — la
politique de sécurité interdisant tout script en ligne, un script bloquant qui
poserait la classe au plus tôt est exclu, et sans `color-scheme` un utilisateur
en thème sombre verrait un écran blanc clignoter à chaque chargement.

**Aucune régression** — Les 458 tests de composants passent, et l'interface
gagne deux garanties qu'elle n'avait pas. D'abord la conformité : tous les
couples texte/fond tiennent AA dans les deux thèmes, y compris ceux qui
échouaient **avant** ce travail — `text-slate-400` sur blanc plafonnait à 3,05
et les bordures de champs à 1,48 là où WCAG 1.4.11 en demande 3. Ensuite la
vérification : la suite Playwright balaie chaque texte de six écrans, dans les
deux thèmes, sur les couleurs calculées par le navigateur.

**Coût assumé** — Trois. `light-dark()` demande un navigateur de 2024 ou plus
récent (Chrome 123, Safari 17.5, Firefox 120) ; sur plus ancien, la valeur est
invalide et le jeton n'est pas servi — dégradation visible, pas silencieuse,
mais dégradation. Ensuite, les bordures de contrôle sont plus contrastées
qu'avant, donc plus présentes : c'est le prix de 1.4.11, et il se voit. Enfin,
le choix d'apparence a fallu le loger quelque part : une barre supérieure mince
apparaît sur tous les écrans, alors que chacun porte déjà son propre en-tête.
Ce n'est pas une coquille applicative — elle reste à proposer.
