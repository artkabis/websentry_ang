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
| Gestion utilisateurs + audit                 | ⬜      | ⬜       | À faire   |
| Analyse (page, batch, sitemap, SSE)          | ✅      | ✅       | **Livré** |
| Feedback beta-testeurs                       | ⬜      | ⬜       | À faire   |
| Messagerie in-app                            | ⬜      | ⬜       | À faire   |
| Analytics d'usage / RGPD                     | ⬜      | ⬜       | À faire   |
| Supervision & santé                          | ⬜      | ⬜       | À faire   |
| Portail documentation                        | ⬜      | ⬜       | À faire   |

**Tests** : 2938 au total — 337 paquet partagé, 1718 unitaires backend,
334 E2E + sécurité API, 502 unitaires frontend, 47 E2E navigateur.
**Couverture** : 100 % lignes paquet partagé, 95,8 % lignes backend
(100 % sur chaque module de sécurité), 98,6 % lignes frontend.

> **Module 4 — livré.** Le pipeline d'analyse est complet (récupération
> SSRF-sûre, profils, pool de threads, flux SSE, sitemap, historisation, suite
> sécurité) et les **29 analyseurs sur 29** de la v1 sont portés : le rapport
> produit est complet et son score comparable à celui de la v1. Côté interface,
> `/analyse` couvre la page unitaire, `/analyse/lot` le lot en flux,
> `/analyse/sitemap` la découverte des pages d'un site, et l'historique se
> parcourt jusqu'au rapport d'une page archivée. Détail dans
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), arbitrages en
> [`docs/DECISIONS.md`](docs/DECISIONS.md) §21 à §25.

---

## Prérequis

- **Node.js ≥ 22.22.3** (exigé par Angular CLI 22)
- **pnpm ≥ 10**
- **MariaDB** (facultatif en développement : `DB_ENABLED=false`)

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

### Créer un compte pour se connecter

Il n'existe **aucun accès sans identifiant** : les écrans sont derrière une
session, et un contournement d'authentification n'est pas une commodité de
développement. Il faut donc une base et un compte — `DB_ENABLED=false` permet de
démarrer l'API, mais pas de s'y connecter.

```bash
# MariaDB doit tourner, et .env porter DB_ENABLED=true + les accès
pnpm --filter @websentry/api build        # le hachage du mot de passe vient du code compilé
pnpm --filter @websentry/api db:init      # applique src/database/sql/*.sql
pnpm --filter @websentry/api db:user alice 'un-mot-de-passe-solide' admin
```

Rangs acceptés : `tester` (10), `editor` (30), `admin` (50), `super_admin`
(100) — ou leur valeur numérique. Rejouer `db:user` sur un identifiant existant
**réinitialise son mot de passe** et invalide les sessions ouvertes : c'est le
geste prévu quand on l'a oublié.

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
