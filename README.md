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
pnpm install
pnpm --filter @websentry/shared build   # à faire EN PREMIER : api et web en dépendent

cp .env.example .env                     # puis renseigner JWT_SECRET
pnpm dev:api                             # http://localhost:3031
pnpm dev:web                             # http://localhost:4200
```

Générer un secret : `openssl rand -hex 32`.

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
