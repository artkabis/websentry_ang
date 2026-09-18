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
- **Moderniser l'UX et l'UI** : ergonomie, hiérarchie visuelle, états de
  chargement et d'erreur, accessibilité, retours immédiats, densité
  d'information, parcours en moins d'étapes. Le fait que la v1 fasse autrement
  n'est pas un argument en soi.
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

## 2. Règle absolue du build

**Un build ne se termine jamais si une erreur est détectée, à n'importe quelle
étape** : lint, format, typecheck, test, couverture sous le seuil, audit CVE.
Aucune exception, aucun contournement manuel sans justification écrite dans
`docs/DECISIONS.md`.

`pnpm audit --audit-level=high` est une étape **bloquante** de la CI. Les
dépendances sont maintenues à jour (Renovate) ; aucune version portant une CVE
connue n'est tolérée.

---

## 3. Seuils de test non négociables

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

## 4. Stack imposée

- **Backend** — Nest.js sur `@nestjs/platform-fastify` (jamais l'adaptateur
  Express), TypeScript strict (`noUncheckedIndexedAccess` compris), Zod comme
  unique moteur de validation, MariaDB via `mysql2` paramétré.
- **Sécurité** — JWT rotatif (accès court + rafraîchissement long, rotation à
  chaque refresh), cookies `httpOnly` + `Secure` + `SameSite=Strict`, CSRF
  double-submit, throttler, `@fastify/helmet`, garde SSRF (DNS multi-adresses,
  épinglage d'IP, plages privées bloquées).
- **Frontend** — Angular standalone, signals, zoneless, Tailwind CSS 4,
  `@tanstack/angular-query-experimental`.
- **Outillage** — monorepo pnpm, Vitest, Playwright, ESLint + Prettier, Husky +
  lint-staged bloquants.

---

## 5. Méthode

Migration **module par module** (strangler pattern) : chaque module est testé,
sécurisé et déployable avant d'entamer le suivant. On écrit en français — code,
commentaires, documentation, messages de commit.

Les commentaires expliquent **pourquoi**, pas quoi. Un commentaire qui paraphrase
la ligne d'en dessous est du bruit.
