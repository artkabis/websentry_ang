# WebSentry v2

Outil d'audit SEO et qualité web (SEO, accessibilité, technique, design), qui
analyse des sites côté serveur, sans navigateur headless.

Cette v2 reprend le périmètre de la v1 (Fastify + React) sur une stack
**Nest.js + Angular**, par migration progressive module par module.

---

## État d'avancement

| Module                                       | Backend | Frontend | État      |
| -------------------------------------------- | ------- | -------- | --------- |
| Auth (cookies + Bearer, JWT rotatif)         | ✅      | ✅       | **Livré** |
| RBAC + permissions fines                     | ✅      | ✅       | **Livré** |
| Socle sécurité (SSRF, CSRF, audit, en-têtes) | ✅      | —        | **Livré** |
| Settings & profils par gamme                 | ✅      | ✅       | **Livré** |
| Historique des scans                         | ✅      | ✅       | **Livré** |
| Gestion utilisateurs + audit                 | ✅      | ✅       | **Livré** |
| Analyse (page, batch, sitemap, SSE)          | ✅      | ✅       | **Livré** |
| Feedback beta-testeurs                       | ✅      | ✅       | **Livré** |
| Messagerie in-app                            | ⬜      | ⬜       | À faire   |
| Analytics d'usage / RGPD                     | ⬜      | ⬜       | À faire   |
| Supervision & santé                          | ✅      | ✅       | **Livré** |
| Portail documentation                        | ⬜      | ⬜       | À faire   |

**Tests** : 3705 au total — 408 paquet partagé, 1980 unitaires backend,
414 E2E + sécurité API, 811 unitaires frontend, 92 E2E navigateur.
**Couverture** : 100 % lignes paquet partagé, 96 % lignes backend
(100 % sur chaque module de sécurité, sur la gestion des comptes, sur le
journal d'audit, sur les retours **et sur la supervision**), 98 % lignes
frontend.

> **Module 4 — livré.** Le pipeline d'analyse est complet (récupération
> SSRF-sûre, profils, pool de threads, flux SSE, sitemap, historisation, suite
> sécurité) et les **29 analyseurs sur 29** de la v1 sont portés : le rapport
> produit est complet et son score comparable à celui de la v1. Côté interface,
> `/analyse` couvre la page unitaire, `/analyse/lot` le lot en flux,
> `/analyse/sitemap` la découverte des pages d'un site, et l'historique se
> parcourt jusqu'au rapport d'une page archivée. Détail dans
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), arbitrages en
>
> [`docs/DECISIONS.md`](docs/DECISIONS.md) §21 à §25.

> **Module 5 — livré.** `/users` porte le CRUD des comptes, la réinitialisation
> de mot de passe et les permissions fines, sous quatre garde-fous : on n'agit
> pas sur un rang supérieur ou égal au sien, on ne se modifie pas soi-même, le
> dernier administrateur actif ne se retire pas, et toute écriture révoque les
> jetons déjà émis. `/audit` ouvre le journal en lecture, réservé au rang 100.
> Côté interface, `/administration/comptes` liste, crée et édite,
> `/administration/journal` donne le journal ; les gestes que les garde-fous
> refuseraient ne sont pas offerts, et leur raison s'affiche à la place.
> Le module exige la base (`503` sans elle) et ses fichiers backend sont
> couverts à **100 %** lignes, branches et fonctions, seuil verrouillé par
> fichier. Arbitrages en [`docs/DECISIONS.md`](docs/DECISIONS.md) §39 à §44.

---

## Prérequis

- **Node.js ≥ 22.22.3** (exigé par Angular CLI 22)
- **pnpm ≥ 10**
- **MariaDB** (facultatif en développement : `DB_ENABLED=false` donne des
  comptes locaux `admin` et `tester`, sans base)

---

## Démarrage

```bash
node -v                                  # doit afficher 22.22.3 ou plus
pnpm install
pnpm --filter @websentry/shared build    # à faire EN PREMIER : api et web en dépendent

cp .env.example .env                     # à la RACINE du dépôt
# puis, dans .env :
#   JWT_SECRET=…                         # openssl rand -hex 32 — obligatoire, 32 caractères
#   DB_ENABLED=false                     # si vous n'avez pas MariaDB en local

pnpm dev:api                             # http://localhost:3031
pnpm dev:web                             # http://localhost:4200  (autre terminal)
```

`pnpm dev:api` compile en continu et relance le serveur à chaque écriture ; le
premier démarrage attend la fin de la compilation initiale, quelques secondes.

### Se connecter

**Sans MariaDB** (`DB_ENABLED=false`) : rien à faire. Au premier démarrage,
l'API crée un compte `admin` et un compte `tester` et **affiche leurs mots de
passe une seule fois** dans le journal :

```
[ComptesLocaux] Mode sans base — comptes locaux créés, notez ces mots de passe :
[ComptesLocaux]   admin / GbJIt7Q59wLQFdRa
[ComptesLocaux]   tester / 4hwsMEKSWmX_zUP3
```

Ils vivent dans `apps/api/.dev-accounts.json`, qui n'est jamais versionné et ne
contient que des empreintes. Pour en changer :

```bash
pnpm --filter @websentry/api build        # le hachage vient du code compilé
pnpm --filter @websentry/api dev:user admin 'un-mot-de-passe-choisi'
```

Ce mode est **refusé en production** : le démarrage échoue si `NODE_ENV=production`
et `DB_ENABLED=false`. Les permissions fines par gamme n'y existent pas — seul le
rang décide.

**Avec MariaDB** (`DB_ENABLED=true`) :

```bash
pnpm --filter @websentry/api build
pnpm --filter @websentry/api db:init      # applique src/database/sql/*.sql
pnpm --filter @websentry/api db:user alice 'un-mot-de-passe-solide' admin
```

Rangs acceptés : `tester` (10), `editor` (30), `admin` (50), `super_admin`
(100) — ou leur valeur numérique. Rejouer `db:user` ou `dev:user` sur un
identifiant existant **réinitialise son mot de passe** et invalide les sessions
ouvertes : c'est le geste prévu quand on l'a oublié.

### Si ça ne démarre pas

| Symptôme                                                         | Cause                                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `The Angular CLI requires a minimum Node.js version of v22.22.3` | Node trop ancien. Ne concerne que le front — l'API, elle, démarre.                                                                             |
| `Cannot find module '@websentry/shared'`                         | Le paquet partagé n'a pas été construit. `pnpm build` à la racine le fait dans le bon ordre.                                                   |
| `Configuration d'environnement invalide : JWT_SECRET …`          | `.env` absent, ou secret de moins de 32 caractères. Le démarrage échoue **volontairement** plutôt que de servir un serveur à moitié configuré. |
| `Connexion MariaDB impossible : ECONNREFUSED`                    | `DB_ENABLED=true` sans base. Passez à `false` : l'analyse fonctionne, seul l'historique est indisponible.                                      |
| `l'analyse s'exécute en ligne`                                   | Ce n'est pas une erreur. Le worker est du JavaScript compilé ; il n'existe qu'après `pnpm --filter @websentry/api build`.                      |

---

## Commandes

| Commande                            | Effet                                          |
| ----------------------------------- | ---------------------------------------------- |
| `pnpm build`                        | Construit les trois paquets                    |
| `pnpm lint` / `pnpm lint:fix`       | ESLint (règles typées)                         |
| `pnpm format` / `pnpm format:check` | Prettier                                       |
| `pnpm type-check`                   | Typecheck des trois paquets, **tests compris** |
| `pnpm test`                         | Tests unitaires                                |
| `pnpm test:coverage`                | Tests + seuils **bloquants**                   |
| `pnpm test:e2e`                     | E2E API (Supertest)                            |
| `pnpm test:security`                | Suite des 15 failles OWASP                     |
| `pnpm audit:ci`                     | Audit CVE (seuil `high`)                       |

---

## Qualité — règle absolue

Un build ne se termine jamais si une erreur est détectée, à quelque étape que ce
soit : lint, format, typecheck, test, couverture sous le seuil, CVE de sévérité
`high` ou supérieure. Aucune étape n'est `continue-on-error`, aucun seuil n'est
consultatif, aucun override manuel n'est prévu.

Seuils de couverture appliqués :

- **Paquet partagé** — 95 % ; il porte le schéma qui garde la frontière HTTP.
- **Backend** — 85 % lignes et branches ; **100 %** sur les modules de sécurité
  (SSRF, mots de passe, CSRF, jetons, gardes, RBAC).
- **Frontend** — 80 % sur les composants et services.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — structure, flux d'une requête,
  modèle d'authentification, RBAC, SSRF
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — arbitrages techniques, leur raison et
  leur coût
- [`docs/SECURITE.md`](docs/SECURITE.md) — les 15 failles et leur couverture,
  mesures permanentes
- [`CLAUDE.md`](CLAUDE.md) — consignes permanentes de développement : règle
  absolue du build, seuils de test, et le cap fonctionnel de la migration
