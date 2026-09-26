# WebSentry v2 — mémoire de projet

Consignes permanentes pour toute session de travail sur ce dépôt. Ce fichier
prime sur les habitudes par défaut ; il ne remplace pas les documents de
référence, il dit **comment** les lire.

| Document               | Rôle                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `README.md`            | État d'avancement, commandes, prérequis                      |
| `docs/ARCHITECTURE.md` | Flux de requête, ordre des gardes, modèle de données, dettes |
| `docs/DECISIONS.md`    | Arbitrages tranchés, avec raison **et** coût assumé          |
| `docs/SECURITE.md`     | Les 15 failles couvertes, tests de mutation                  |

---

## 1. La migration n'est pas une transcription

La v2 reprend le périmètre de la v1 (Fastify + React → Nest.js + Angular), mais
**elle n'est pas tenue de reproduire ses choix fonctionnels quand ils sont
perfectibles**. Porter à l'identique une logique métier bancale, c'est payer
deux fois : une fois pour la recopier, une fois pour la corriger plus tard.

Sont donc **autorisées et attendues**, sans demander à chaque fois :

- **Améliorer une logique métier** quand le port met au jour une incohérence, un
  cas limite non traité, une règle implicite jamais écrite, ou un comportement
  que les tests de la v1 ne garantissaient pas.
- **Moderniser l'UX et l'UI** — ergonomie, hiérarchie visuelle, états de
  chargement et d'erreur, accessibilité, retours immédiats, densité
  d'information, parcours en moins d'étapes. Le fait que la v1 fasse autrement
  n'est pas un argument en soi. Le cap détaillé est au §2.
- **Proposer des fonctionnalités adjacentes** quand elles tombent naturellement
  du module en cours et coûtent peu à côté de ce qui est déjà construit.

### Les garde-fous qui encadrent cette liberté

1. **Aucune régression.** Ce que la v1 fait, la v2 le fait — au minimum. Une
   amélioration qui retire une capacité existante n'est pas une amélioration :
   c'est un arbitrage, et il se discute avant.
2. **Tout écart se documente.** Une divergence fonctionnelle assumée par rapport
   à la v1 entre dans `docs/DECISIONS.md` avec sa raison **et son coût**. Un
   arbitrage sans coût énoncé est un arbitrage mal instruit.
3. **Le périmètre demandé reste le livrable.** Améliorer ne veut pas dire
   élargir : on ne remplace pas le module demandé par un autre, et une refonte
   large se propose avant de se coder.
4. **La barre de qualité ne bouge pas.** Une amélioration franchit exactement les
   mêmes portes que le reste : tests, couverture, sécurité, lint, typecheck.
5. **Ce qui touche à la sécurité ne s'« améliore » pas par confort.** On durcit,
   jamais on n'assouplit — et jamais sans test qui le prouve.

---

## 2. Cap UX/UI : moderne et fonctionnel, dans cet ordre

Reproduire l'interface de la v1 n'est pas un objectif. Les principes ci-dessous
s'appliquent à chaque écran produit ou repris.

**Toujours quatre états, jamais un seul.** Un écran qui affiche des données a un
état _chargement_, _vide_, _erreur_ et _nominal_. Le vide explique quoi faire
ensuite plutôt que d'afficher « Aucun résultat » ; l'erreur dit ce qui a échoué
et propose une reprise ; le chargement utilise un squelette calqué sur la forme
réelle du contenu, pas un spinner centré qui fait sauter la mise en page.

**Le retour est immédiat.** Une action rend la main tout de suite : état en
attente sur le contrôle actionné, jamais un gel silencieux. Là où l'écriture est
sûre et réversible, on affiche le résultat par anticipation et on corrige si le
serveur refuse. Ce qui est destructeur se confirme ; ce qui ne l'est pas
s'annule plutôt qu'il ne se confirme.

**L'erreur est exploitable.** Un message dit ce qui s'est passé, pourquoi, et
quelle est la prochaine action — au plus près du champ concerné. La validation
côté client rejoue le schéma partagé et avertit avant l'appel réseau, sans
jamais s'y substituer : l'API reste la seule autorité.

**L'accessibilité n'est pas une option.** Cible WCAG 2.2 AA : navigation
clavier complète et ordre de tabulation cohérent, focus toujours visible, rôles
et libellés explicites, contrastes vérifiés, annonces des changements d'état aux
lecteurs d'écran (`role="status"`, `aria-live`), respect de
`prefers-reduced-motion`. Les tests de composants interrogent l'arbre
accessible (rôles et libellés) plutôt que des classes CSS : ce qui est testable
par le rôle est utilisable au clavier.

**La densité sert l'expert.** WebSentry s'adresse à une équipe qualité qui
enchaîne les audits : tableaux triables et filtrables, filtres reflétés dans
l'URL (donc partageables et rechargeables), sélection multiple et actions
groupées là où le geste est répétitif, raccourcis clavier sur les parcours
quotidiens. On préfère montrer l'information plutôt que de l'enfouir sous des
onglets.

**Cohérence par composants.** Tailwind 4 avec des jetons de design (couleurs,
espacements, rayons, typographie) définis une fois et réutilisés ; des
composants partagés pour tout motif qui apparaît deux fois. Pas de valeurs
arbitraires dispersées dans les gabarits. Responsive réel, thème sombre inclus
dès la conception et non ajouté après coup.

**Angular moderne.** Standalone, signals, zoneless, `@if`/`@for`,
`input()`/`output()`, `OnPush` implicite, chargement différé par route.
Le rendu ne bloque pas sur la donnée la plus lente de la page.

---

## 3. Règle absolue du build

**Un build ne se termine jamais si une erreur est détectée, à n'importe quelle
étape** : lint, format, typecheck, test, couverture sous le seuil, audit CVE.
Aucune exception, aucun contournement manuel sans justification écrite dans
`docs/DECISIONS.md`.

`pnpm audit --audit-level=high` est une étape **bloquante** de la CI. Les
dépendances sont maintenues à jour (Renovate) ; aucune version portant une CVE
connue n'est tolérée.

---

## 4. Seuils de test non négociables

| Périmètre                                    | Seuil                |
| -------------------------------------------- | -------------------- |
| Services et gardes backend                   | 85 % lignes/branches |
| Modules de sécurité (auth, RBAC, CSRF, SSRF) | **100 %**            |
| Paquet partagé                               | 95 %                 |
| Frontend                                     | 80 %                 |

Un test qui ne peut pas échouer ne compte pas. Quand une branche est
inatteignable, on encode l'invariant dans le type plutôt que d'écrire un test
creux pour flatter la couverture.

---

## 5. Stack imposée

- **Backend** — Nest.js sur `@nestjs/platform-fastify` (jamais l'adaptateur
  Express), TypeScript strict (`noUncheckedIndexedAccess` compris), Zod comme
  unique moteur de validation, MariaDB via `mysql2` paramétré.
- **Sécurité** — JWT rotatif (accès court + rafraîchissement long, rotation à
  chaque refresh), cookies `httpOnly` + `Secure` + `SameSite=Strict`, CSRF
  double-submit, throttler, `@fastify/helmet`, garde SSRF (DNS multi-adresses,
  épinglage d'IP, plages privées bloquées).
- **Frontend** — Angular standalone, signals, zoneless, Tailwind CSS 4. Le
  chargement des données se fait en signals, sans client de requêtes tiers
  (arbitrage 67).
- **Outillage** — monorepo pnpm, Vitest, Playwright, ESLint + Prettier, Husky +
  lint-staged bloquants.

---

## 6. Méthode

Migration **module par module** (strangler pattern) : chaque module est testé,
sécurisé et déployable avant d'entamer le suivant. On écrit en français — code,
commentaires, documentation, messages de commit.

Les commentaires expliquent **pourquoi**, pas quoi. Un commentaire qui paraphrase
la ligne d'en dessous est du bruit.
