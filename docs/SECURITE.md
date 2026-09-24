# Sécurité — WebSentry v2

## Suite des 15 failles

Suite automatisée, **step bloquant de la CI** :
`pnpm --filter @websentry/api test:security` → `apps/api/test/security/`.

Neuf fichiers, un par surface d'attaque distincte :

- `owasp.e2e-spec.ts` — le socle (auth, RBAC, en-têtes) ;
- `owasp-profiles.e2e-spec.ts` — la surface du module 2 : routes d'écriture
  administrateur, dictionnaire à clés libres, nom de gamme circulant jusqu'à un
  en-tête HTTP, import de fichier ;
- `owasp-scans.e2e-spec.ts` — celle du module 3 : recherche à nombreux filtres
  alimentant une requête SQL, **tri atteignant la structure de cette requête**,
  contrôle d'accès à deux niveaux (permission globale contre appartenance
  personnelle), suppressions irréversibles en masse ;
- `owasp-analysis.e2e-spec.ts` — celle du module 4, la plus exposée : c'est le
  **seul module qui émette des requêtes sortantes**, vers une URL fournie par
  l'appelant ;
- `owasp-admin.e2e-spec.ts` — celle des modules 5 et 7 : les routes qui
  **fabriquent les comptes et les rangs**, donc celles dont la compromission
  donne tout le reste, plus le journal d'audit et le relevé de supervision ;
- `owasp-feedback.e2e-spec.ts` — celle du module 6 : le **seul point d'écriture
  ouvert à tout compte authentifié**, avec du texte libre déposé par un
  utilisateur et relu par un autre ;
- `owasp-messagerie.e2e-spec.ts` — celle du module 8 : le **seul module qui
  accepte un fichier**. Ses requêtes sont FORGÉES OCTET PAR OCTET, parce qu'un
  client HTTP normal nettoie le nom de fichier avant de l'envoyer — une suite
  qui s'appuierait sur lui vérifierait la politesse du client, pas la défense
  du serveur ;
- `owasp-usage.e2e-spec.ts` — celle du module 9. La surface est petite — deux
  lectures — mais elle est particulière : c'est le **seul module dont la raison
  d'être est de parler des personnes sans les nommer**. Le risque n'y est pas
  qu'il laisse écrire, c'est qu'il laisse RÉIDENTIFIER ;
- `owasp-docs.e2e-spec.ts` — celle du module 10, le **seul module qui lise des
  fichiers**. Deux risques y seraient classiques — traversée de chemin et XSS
  stocké — et l'architecture les retire tous les deux : les pages sont servies
  depuis une table en mémoire, et l'API rend une structure typée plutôt que du
  HTML. La suite le vérifie quand même : c'est le genre de garantie qu'une
  refonte fait sauter sans le dire.

Elle s'exécute contre l'application **assemblée** et la sollicite par HTTP réel.

| #   | Faille                        | Vérifié par                                                                                                                                                                                                                                                                                                                                                                                            | Où                                                                                                                              |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Injection SQL                 | 6 charges classiques n'authentifient ni n'altèrent l'état ; 4 charges sur chaque filtre de recherche ; tri hors liste fermée refusé ; opérateurs du mode booléen neutralisés ; rang et statut hors catalogue refusés plutôt qu'interpolés ; charge stockée relue comme du **texte**                                                                                                                    | OWASP §1, scans §1, admin §1, retours §1, messagerie §1, usage §1, docs §1 + `*.repository.spec.ts`                             |
| 2   | XSS stocké / réfléchi         | CSP sans `unsafe-inline` ni `unsafe-eval`, `nosniff`, aucun écho de charge, `Content-Type` non interprétable en HTML ; charge HTML déposée puis relue en JSON non interprétable ; pièce jointe servie en `attachment` sous une CSP muette, SVG refusé ; **la documentation ne transporte aucun balisage** — blocs typés, adresses de lien limitées à `doc:` et `https:`                                | OWASP §2, retours §2, messagerie §2, **docs §2**                                                                                |
| 3   | CSRF                          | Mutation par cookie refusée sans en-tête et sur en-tête divergent ; Bearer exempté ; échecs journalisés ; `SameSite=Strict`                                                                                                                                                                                                                                                                            | OWASP §3, admin §3, retours §3, messagerie §3 + `csrf.guard.spec.ts`                                                            |
| 4   | Authentification cassée       | `alg:none` rejeté, charge utile modifiée rejetée, révocation immédiate, refresh à usage unique, access token borné à 15 min                                                                                                                                                                                                                                                                            | OWASP §4 + `token.service.spec.ts`                                                                                              |
| 5   | Contrôle d'accès défaillant   | Fermé par défaut, `ws_role` non falsifiable, IDOR impossible, élévation refusée ; historique cloisonné par compte ; **trois régimes** d'administration distingués ; auto-élévation, vol de mot de passe d'un rang supérieur et écritures absentes vérifiés route par route                                                                                                                             | OWASP §5, scans §5, admin §5, retours §5, messagerie §5, usage §5, docs §5 + `*.guard.spec.ts`                                  |
| 6   | Mauvaise configuration        | 8 en-têtes OWASP vérifiés par test, pile serveur non annoncée, CORS tiers refusé, préfixe `/api/v1` appliqué                                                                                                                                                                                                                                                                                           | OWASP §6                                                                                                                        |
| 7   | Données sensibles exposées    | DTO de sortie en liste blanche, aucun jeton dans le corps, sonde publique muette ; ni empreinte ni compteur d'échec exposés, mot de passe réinitialisé non renvoyé, adresses IP du journal réservées au rang 100, relevé de supervision muet sur l'infrastructure ; **agrégats d'usage muets sur les personnes**, fenêtre d'observation fermée à 7 jours au plus court                                 | OWASP §7, admin §7, retours §7, messagerie §7, **usage §7** + `auth.service.spec.ts`                                            |
| 8   | SSRF                          | Blocklist exhaustive, refus multi-enregistrements, re-validation par redirection, épinglage IP                                                                                                                                                                                                                                                                                                         | `ip-rules.spec.ts`, `ssrf.service.spec.ts`, `safe-fetch.spec.ts` (**100 %**) + `owasp-analysis.e2e-spec.ts` § adresses internes |
| 9   | Désérialisation non sécurisée | JSON malformé, pollution de prototype, charge non-objet, `Content-Type` non pris en charge ; clé dangereuse soumise à la création d'un compte et dans le contexte d'un retour                                                                                                                                                                                                                          | OWASP §9, admin §9, retours §9, messagerie §9                                                                                   |
| 10  | Composants vulnérables        | `pnpm audit --audit-level=high` bloquant + Renovate                                                                                                                                                                                                                                                                                                                                                    | CI                                                                                                                              |
| 11  | Journalisation insuffisante   | 5 événements d'audit vérifiés, verrouillage tracé, aucun mot de passe journalisé, IP et acteur conservés ; **le corps d'un retour n'est jamais recopié dans le journal**                                                                                                                                                                                                                               | OWASP §11, retours §7, messagerie §7                                                                                            |
| 12  | Force brute                   | Verrouillage après 5 échecs (persisté en base), sans impact sur les autres comptes de la même IP, compteurs exposés ; **429 réellement provoqués** sur la création de compte, la réinitialisation de mot de passe, le dépôt d'un retour et l'envoi d'un message                                                                                                                                        | OWASP §12, admin §12, retours §12, messagerie §12, usage §12, docs §12 + `login-throttle.service.spec.ts`                       |
| 13  | Fuite par messages d'erreur   | Aucune stack trace, forme uniforme + `requestId`, aucun détail de base, aucun oracle d'énumération — y compris entre « compte inexistant » et « compte existant » et entre « retour d'autrui » et « retour absent »                                                                                                                                                                                    | OWASP §13, admin §7, retours §5 + `all-exceptions.filter.spec.ts`                                                               |
| 14  | Traversée de chemin           | 4 encodages, aucun service de fichiers statiques exposé ; identifiants validés comme UUID avant d'atteindre quoi que ce soit ; **nom de fichier porteur de chemin, octet nul, type menteur, SVG, archive et exécutable refusés** sur requête forgée à la main ; le portail documentaire sert depuis une table EN MÉMOIRE — 8 formes de traversée refusées, et aucun chemin du serveur dans les erreurs | OWASP §14, admin §14, retours §14, **messagerie §14**, **docs §14** + `attachment-storage.service.spec.ts` (**100 %**)          |
| 15  | Mass assignment               | Clés surnuméraires rejetées (`.strict()`), 11 charges malformées, bornes exactes, corps surdimensionné ; `status`, `tokenVersion`, `passwordHash`, `id`, `authorId` et `assignedTo` refusés un à un ; transition de statut illégale refusée                                                                                                                                                            | OWASP §15, admin §15, retours §15, messagerie §15, docs §15                                                                     |

**Note sur la faille n°8** — La dette de couverture E2E signalée jusqu'au module 3
est LEVÉE : les routes d'analyse émettent des requêtes sortantes, et la suite du
module 4 vérifie que `file://`, `gopher://`, `data:`, `javascript:` et `ftp://`
sont refusés dès la validation du schéma — sur l'analyse unitaire, dans un lot,
sur le flux SSE et à la lecture d'un sitemap. Un sitemap est traité comme une
source NON FIABLE : c'est une liste d'URL contrôlée par le site analysé.

**Note sur la faille n°12** — Jusqu'au module 4, l'efficacité du throttler
n'était prouvée que sur la connexion : ailleurs, la configuration était lue mais
jamais éprouvée. Les suites des modules 5 à 7 **provoquent de vrais 429** en
dépassant le quota de `POST /users`, de `POST /users/:id/password` et de
`POST /feedback`. Une limite mal câblée est désormais un test rouge, pas une
ligne de configuration que personne ne relit.

### Ce que ces deux suites établissent en propre

- **Le cloisonnement du feedback tient sur la requête SQL, pas sur l'affichage.**
  Un testeur qui demande explicitement la vue globale (`mine=false`) n'obtient
  toujours que ses retours : le filtre d'auteur est posé avant la base, jamais
  retiré par un paramètre d'URL.
- **L'IDOR rend 404, et le 404 est indiscernable.** Le retour d'autrui et le
  retour inexistant renvoient le **même message** — le test compare les deux
  corps. Un 403 aurait confirmé l'existence de la ressource.
- **Le journal d'audit et la supervision n'offrent aucune écriture.** Ce n'est
  pas une politique de garde, c'est l'absence de route : les tests énumèrent
  `POST`, `PATCH`, `PUT` et `DELETE` sur ces deux surfaces et exigent un 404.
- **Le triage n'appartient pas à l'auteur.** Même sur son propre retour, un
  compte sans `feedback:read` ne peut pas changer le statut : déposer n'est pas
  instruire.

### Ce qui reste hors de portée de ces suites

Les suites tournent sur le double en mémoire de la base. Les contraintes
`CHECK` et les clés étrangères de `004-feedback.sql` sont donc vérifiées **par
lecture du schéma, pas par exécution**. Tant qu'aucun job MariaDB ne tourne en
CI, une contrainte mal écrite passerait la suite. La dette est ouverte et
assumée : la défense applicative ne s'appuie sur aucune de ces contraintes, qui
sont une seconde barrière, pas la première.

---

## Les tests détectent-ils vraiment une régression ?

Une suite qui passe ne prouve rien si elle passerait aussi sans la défense.
Chaque module est donc soumis à des mutations : on casse la défense, on exige
que la suite vire au rouge.

### Sur le socle et les modules 2 à 4

| Mutation appliquée                                                       | Résultat attendu                     | Observé     |
| ------------------------------------------------------------------------ | ------------------------------------ | ----------- |
| Retrait de `.strict()` sur `LoginSchema`                                 | Le test de mass assignment échoue    | ✅ 1 échec  |
| Retrait de `CsrfGuard` des gardes globales                               | Les tests CSRF échouent              | ✅ 4 échecs |
| `history:delete` remplacé par `history:read` sur la suppression en masse | Le test de cloisonnement échoue      | ✅ 1 échec  |
| Rapport purgé rendu indiscernable d'un rapport en clair                  | Les tests d'état du rapport échouent | ✅ 2 échecs |

### Sur les modules 5 à 7

Ces mutations ont été appliquées aux **garde-fous des services**, contre leurs
suites unitaires — pas contre les deux suites OWASP ci-dessus, qui n'ont pas
encore été éprouvées par mutation (voir la réserve en fin de section).

| Périmètre muté                     | Mutants | Résultat                                                               |
| ---------------------------------- | ------: | ---------------------------------------------------------------------- |
| Garde-fous des comptes (module 5)  |      17 | 2 **survivants** au premier passage → 2 tests ajoutés, puis 17/17 tués |
| Garde-fous des retours (module 6)  |      15 | 2 mutants **équivalents** → 1 branche morte supprimée, puis 15/15 tués |
| Verdicts de supervision (module 7) |      14 | 1 **survivant** → 2 tests d'isolement ajoutés, puis 14/14 tués         |

Les trois survivants nommaient de vraies lacunes, et c'est tout l'intérêt de
l'exercice :

- **Comptes** — le refus d'auto-modification n'était prouvé que là où le
  garde-fou de rang le couvrait déjà, donc jamais pour un `super_admin` ; et la
  **rétrogradation** du dernier administrateur actif n'était jamais exercée, la
  suite ne testant que sa désactivation.
- **Supervision** — les trois composants étaient testés « à tour de rôle » sans
  jamais en isoler un : retirer la rétention du calcul du verdict global ne
  faisait tomber aucun test.

Les deux mutants **équivalents** du module 6 ne sont pas des trous de test : le
code muté se comportait exactement comme l'original. Le second désignait une
branche réellement **morte**, supprimée plutôt que couverte par un test creux
(`CLAUDE.md` §4).

Une mutation porte enfin sur la **déclaration** plutôt que sur le code : retirer
un décorateur de permission d'une route. Aucun test fonctionnel ne le voit — la
garde laisse simplement passer. Un test par **réflexion** lit la permission
posée sur chaque route et tombe dès qu'une route apparaît sans décorateur.

> Les mutations décrites ci-dessus ont été appliquées temporairement puis
> révoquées. Aucune n'est présente dans l'arbre : le dépôt ne contient que la
> version durcie.

### Sur le module 8

Cinq mutations sur `messages.service.ts`, appliquées aux garde-fous et à ce que
le journal retient. Trois mutations supplémentaires sur le schéma partagé, où
vit la reconnaissance des pièces jointes.

| Mutation appliquée                                               | Résultat attendu                       | Observé     |
| ---------------------------------------------------------------- | -------------------------------------- | ----------- |
| Garde de visibilité retirée du téléchargement d'une pièce jointe | La pièce d'autrui devient lisible      | ✅ 2 échecs |
| L'auteur n'est plus ajouté à ses propres destinataires           | Il ne peut plus se relire              | ✅ 1 échec  |
| La copie de l'auteur n'est plus marquée lue                      | Sa propre annonce l'interrompt         | ✅ 1 échec  |
| Le `NULL` de `SUM()` n'est plus converti en zéro                 | La pastille affiche « null »           | ✅ 2 échecs |
| Le corps du message entre dans les détails d'audit               | Le journal archive la correspondance   | ✅ 1 échec  |
| `every` → `some` sur les signatures de type de fichier           | Un conteneur RIFF non-WebP est accepté | ✅ 1 échec  |
| Le nom de repli d'une pièce jointe disparaît                     | L'en-tête de téléchargement sort vide  | ✅ 1 échec  |
| Le refus d'une cible que l'audience n'attend pas est retiré      | Un envoi « à tous » paraît restreint   | ✅ 1 échec  |

Deux de ces mutations ont d'abord été posées sur la **mauvaise occurrence** —
la première du fichier, pas celle visée. Elles ont tué un test, mais pas le bon.
Le constat vaut d'être écrit : une mutation qui fait rougir la suite n'a rien
prouvé tant qu'on n'a pas vérifié **quel** test est tombé.

### Sur le module 9

Sept mutations, sept tuées. Elles portent sur les deux garanties du module :
ne jamais rendre une identité, et retirer celles du journal passé le délai.

| Mutation appliquée                                     | Résultat attendu                                 | Observé    |
| ------------------------------------------------------ | ------------------------------------------------ | ---------- |
| `ip_address` n'est plus retirée à l'anonymisation      | Une adresse survit au délai                      | ✅ 1 échec |
| L'anonymisation ne traite qu'un seul lot               | Le reste du journal n'est jamais traité          | ✅ 1 échec |
| `COUNT(*)` au lieu de `COUNT(DISTINCT actor_id)`       | Le tunnel compte des événements, pas des comptes | ✅ 1 échec |
| Le `WHERE` laisse passer les lignes déjà anonymisées   | Des comptes actifs sont inventés                 | ✅ 1 échec |
| La moyenne par gamme redevient une moyenne de moyennes | Un score faux sur les gros sites                 | ✅ 1 échec |
| La série quotidienne saute les jours vides             | La courbe ment sur sa pente                      | ✅ 1 échec |
| Le registre annonce une collecte dédiée                | Le module se déclare collecteur                  | ✅ 1 échec |

L'une de ces mutations a d'abord été lancée contre la **mauvaise suite** : la
suite E2E, qui tourne sur un double en mémoire et ne voit donc aucun SQL. Elle
y a « survécu » sans rien prouver. Relancée contre la spec du dépôt, elle est
tombée immédiatement. Le constat rejoint celui du module 8, sous un autre
angle : **une mutation ne prouve quelque chose que contre la suite capable de
la voir**.

### Sur le module 10

| Mutation appliquée                                    | Résultat attendu                           | Observé                           |
| ----------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| L'adresse d'un lien n'est plus vérifiée               | `javascript:` devient un lien              | ✅ 2 échecs                       |
| Le nom de fichier n'est plus validé comme identifiant | Un fichier mal nommé entre au portail      | ❌ **équivalent** → voir ci-après |
| Le garde anti-boucle de la recherche disparaît        | Un terme vide fait tourner sans fin        | ✅ la suite se bloque             |
| Le titre ne pèse plus dans le score de recherche      | La page cherchée passe après ses citations | ✅ 1 échec                        |
| Un bloc de code voit son contenu interprété           | `## ` dans un exemple devient un titre     | ✅ 30 échecs                      |

Le mutant **équivalent** mérite son paragraphe. Retirer la validation du nom de
fichier ne change RIEN de ce que l'API sert : le schéma refuse la page un peu
plus loin, et le chargeur l'ignore de la même façon. Deux défenses, une seule
observable.

La valeur du contrôle explicite est ailleurs — dans le **diagnostic**. Sans
lui, l'exploitant lit une erreur de schéma sur une page qu'il n'a pas écrite,
au lieu de « ce nom de fichier n'est pas un identifiant ». Un test fixe donc
désormais le message d'avertissement, et la mutation tombe. C'est le seul cas
de cette suite où la réponse à un mutant équivalent n'a pas été de supprimer du
code, mais de **tester ce à quoi il sert vraiment**.

**Réserve assumée** — `owasp-admin.e2e-spec.ts` et `owasp-feedback.e2e-spec.ts`
n'ont pas encore subi de contrôle par mutation. Les garde-fous qu'elles
attaquent l'ont été au niveau du service, mais rien ne prouve encore qu'une
régression posée sur la **route** (un décorateur retiré, un throttler débranché)
ferait virer ces deux suites au rouge. Le contrôle reste à faire ; la dette est
ouverte plutôt que tue.

---

## Mesures permanentes

### Cookies

`httpOnly` sur les jetons, `Secure` en production, `SameSite=Strict` partout,
`ws_refresh` limité à son chemin. Le caractère non-httpOnly de `ws_csrf` et
`ws_role` est délibéré et justifié dans `ARCHITECTURE.md`.

### JWT rotatif

Access 15 min (**plafond dur**, qu'aucune configuration ne peut allonger),
refresh 7 j à usage unique, rotation atomique, révocation serveur par
`token_version`.

### Mots de passe

scrypt (N=2^14, r=8, p=1, 64 octets), sel aléatoire par compte, comparaison à
temps constant. **Asynchrone**, contrairement à la v1 : `scryptSync` bloquait la
boucle d'événements ~100 ms par tentative, ce qui offrait un levier de déni de
service trivial.

### Anti-énumération de comptes

Message d'erreur identique, coût scrypt identique (hash factice sur identifiant
inconnu), temporisation uniforme de 500 ms, verrouillage révélé seulement après
validation du mot de passe.

### Administration : quatre garde-fous, jamais contournables par l'interface

Les routes de gestion des comptes portent quatre invariants, vérifiés par le
**service** et non par l'écran : ne jamais accorder au-dessus de son propre
rang, ne jamais se modifier soi-même, ne jamais retirer le dernier
administrateur actif, et révoquer les jetons à chaque écriture.

L'interface rejoue ces mêmes règles pour ne pas proposer un geste voué au 403
(`user-filters.ts`), mais ce rejeu est un **confort d'ergonomie** : il n'a
aucune valeur de sécurité et la suite le vérifie en attaquant l'API directement,
sans passer par l'écran.

### Pollution de prototype — trois couches

Le module 2 introduit des dictionnaires à clés libres (`checkWeights`,
`subCheckPolarity`). Trois couches indépendantes les protègent :

1. **Fastify** refuse `__proto__` dès l'analyse du corps JSON (400) ;
2. le **pipe de validation de Nest** retire `constructor` et `prototype` avant
   de valider, si bien que la requête aboutit mais débarrassée de la clé ;
3. le **schéma partagé** les rejette explicitement, ce qui couvre les chemins qui
   n'empruntent pas le pipe — import depuis un fichier, appel direct au service.

Les tests portent sur le RÉSULTAT et non sur l'une de ces couches : quel que soit
le code de statut, la clé dangereuse ne doit jamais être persistée et le
prototype ne doit jamais bouger.

### Historique : aucune écriture depuis l'extérieur

L'historique des scans est une base de **preuve** : on s'y réfère pour dire ce
qu'était l'état d'un site à une date. Aucune route HTTP ne l'alimente —
l'ingestion se fait en process depuis le module d'analyse.

Un endpoint d'ingestion offrirait à un jeton volé le moyen de **fabriquer un
passé** : des audits qui n'ont jamais eu lieu, des scores jamais mesurés. Aucune
validation d'entrée ne protège de cela, puisque la charge serait parfaitement
conforme. La seule défense est l'absence de porte, et un test le vérifie
(`owasp-scans`, §6).

Les suppressions, elles, existent — mais elles exigent `history:delete`, sont
limitées en débit (5 appels/min pour la portée la plus large), bornées à 200
identifiants, et **toutes journalisées** avec leur acteur et leur portée.

### Journal d'audit et supervision : deux surfaces en lecture seule

Le journal d'audit est soumis au même raisonnement que l'historique : s'il
acceptait une écriture, il cesserait d'être une preuve. Il est réservé au rang
100 et n'expose que `GET`. La supervision suit la même règle, pour une raison
différente : un relevé d'état qu'on pourrait poser depuis l'extérieur ne
relèverait plus rien.

Le relevé ne nomme jamais l'infrastructure — ni hôte, ni port, ni moteur, ni
chemin — et un test l'exige explicitement. Quand la base est injoignable, les
volumétries valent `null` et non zéro : un zéro est une mesure, `null` est une
absence de mesure, et confondre les deux fait passer une panne pour un système
vide.

### Conservation limitée — et ce qu'elle coûte

Le journal d'audit perd son IDENTITÉ passé `AUDIT_ANONYMIZE_AFTER_DAYS`
(180 jours par défaut) : identifiant, nom et adresse IP sont retirés par un
travail de fond quotidien. L'action, sa cible et son horodatage RESTENT — les
effacer reviendrait à prétendre que rien ne s'est passé.

La garantie d'append-only du module 5 tient toujours, avec sa portée exacte :
le journal est inréécrivable sur **ce qui s'est passé**, pas éternel sur **qui
l'a fait**. `AuditRepository` n'expose toujours ni UPDATE ni DELETE ;
l'anonymisation passe par un autre dépôt, qu'aucun contrôleur n'atteint. Un
test l'exige : `POST /usage/anonymiser` rend 404, et le journal est vérifié
intact après la tentative.

Conséquence assumée : un incident vieux de plus de six mois ne peut plus être
attribué à une personne. C'est le but.

La suppression d'un compte anonymise déjà ses traces par les clés étrangères
(`ON DELETE SET NULL`). Deux mécanismes concourent donc au même effet, l'un
immédiat et ciblé, l'autre différé et massif : le droit à l'effacement ne peut
pas dépendre d'un minuteur.

### Audit des dépendances

`pnpm audit --audit-level=high` bloquant en CI. Renovate fusionne
automatiquement les mineures **si la CI est verte de bout en bout** ; les
majeures et les alertes de vulnérabilité restent manuelles.

---

## Signaler une vulnérabilité

Ne pas ouvrir d'issue publique. Contacter directement le mainteneur du dépôt.
