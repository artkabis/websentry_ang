# Sécurité — WebSentry v2

## Suite des 15 failles

Suite automatisée, **step bloquant de la CI** :
`pnpm --filter @websentry/api test:security` → `apps/api/test/security/`.

Trois fichiers :

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
  l'appelant.

Elle s'exécute contre l'application **assemblée** et la sollicite par HTTP réel.

| #   | Faille                        | Vérifié par                                                                                                                                                                                                                                   | Où                                                                           |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Injection SQL                 | 6 charges classiques n'authentifient ni n'altèrent l'état ; 4 charges sur chaque filtre de recherche ; tri hors liste fermée refusé ; opérateurs du mode booléen neutralisés ; chaque repository vérifié sur la séparation requête/paramètres | OWASP §1, scans §1 + `*.repository.spec.ts`                                  |
| 2   | XSS stocké / réfléchi         | CSP sans `unsafe-inline` ni `unsafe-eval`, `nosniff`, aucun écho de charge, `Content-Type` non interprétable en HTML                                                                                                                          | OWASP §2                                                                     |
| 3   | CSRF                          | Mutation par cookie refusée sans en-tête et sur en-tête divergent ; Bearer exempté ; échecs journalisés ; `SameSite=Strict`                                                                                                                   | OWASP §3 + `csrf.guard.spec.ts`                                              |
| 4   | Authentification cassée       | `alg:none` rejeté, charge utile modifiée rejetée, révocation immédiate, refresh à usage unique, access token borné à 15 min                                                                                                                   | OWASP §4 + `token.service.spec.ts`                                           |
| 5   | Contrôle d'accès défaillant   | Fermé par défaut, `ws_role` non falsifiable, IDOR impossible sur `/auth/me`, élévation refusée ; historique cloisonné par compte, avec 404 indiscernable entre « scan d'autrui » et « scan inexistant »                                       | OWASP §5, scans §5 + `*.guard.spec.ts`                                       |
| 6   | Mauvaise configuration        | 8 en-têtes OWASP vérifiés par test, pile serveur non annoncée, CORS tiers refusé, préfixe `/api/v1` appliqué                                                                                                                                  | OWASP §6                                                                     |
| 7   | Données sensibles exposées    | DTO de sortie en liste blanche, aucun jeton dans le corps, sonde publique muette                                                                                                                                                              | OWASP §7 + `auth.service.spec.ts`                                            |
| 8   | SSRF                          | Blocklist exhaustive, refus multi-enregistrements, re-validation par redirection, épinglage IP                                                                                                                                                | `ip-rules.spec.ts`, `ssrf.service.spec.ts`, `safe-fetch.spec.ts` (**100 %**) |
| 9   | Désérialisation non sécurisée | JSON malformé, pollution de prototype, charge non-objet, `Content-Type` non pris en charge                                                                                                                                                    | OWASP §9                                                                     |
| 10  | Composants vulnérables        | `pnpm audit --audit-level=high` bloquant + Renovate                                                                                                                                                                                           | CI                                                                           |
| 11  | Journalisation insuffisante   | 5 événements d'audit vérifiés, verrouillage tracé, aucun mot de passe journalisé, IP et acteur conservés                                                                                                                                      | OWASP §11                                                                    |
| 12  | Force brute                   | Verrouillage après 5 échecs (persisté en base), sans impact sur les autres comptes de la même IP, compteurs exposés                                                                                                                           | OWASP §12 + `login-throttle.service.spec.ts`                                 |
| 13  | Fuite par messages d'erreur   | Aucune stack trace, forme uniforme + `requestId`, aucun détail de base, aucun oracle d'énumération                                                                                                                                            | OWASP §13 + `all-exceptions.filter.spec.ts`                                  |
| 14  | Traversée de chemin           | 4 encodages, aucun service de fichiers statiques exposé                                                                                                                                                                                       | OWASP §14                                                                    |
| 15  | Mass assignment               | Clés surnuméraires rejetées (`.strict()`), 11 charges malformées, bornes exactes, corps surdimensionné                                                                                                                                        | OWASP §15                                                                    |

**Note sur la faille n°8** — La dette de couverture E2E signalée jusqu'au module 3
est LEVÉE : les routes d'analyse émettent des requêtes sortantes, et la suite du
module 4 vérifie que `file://`, `gopher://`, `data:`, `javascript:` et `ftp://`
sont refusés dès la validation du schéma — sur l'analyse unitaire, dans un lot,
sur le flux SSE et à la lecture d'un sitemap. Un sitemap est traité comme une
source NON FIABLE : c'est une liste d'URL contrôlée par le site analysé.

---

## Les tests détectent-ils vraiment une régression ?

Une suite qui passe ne prouve rien si elle passerait aussi sans la défense.
Deux contrôles par mutation ont donc été effectués sur le socle :

| Mutation appliquée                                                       | Résultat attendu                     | Observé     |
| ------------------------------------------------------------------------ | ------------------------------------ | ----------- |
| Retrait de `.strict()` sur `LoginSchema`                                 | Le test de mass assignment échoue    | ✅ 1 échec  |
| Retrait de `CsrfGuard` des gardes globales                               | Les tests CSRF échouent              | ✅ 4 échecs |
| `history:delete` remplacé par `history:read` sur la suppression en masse | Le test de cloisonnement échoue      | ✅ 1 échec  |
| Rapport purgé rendu indiscernable d'un rapport en clair                  | Les tests d'état du rapport échouent | ✅ 2 échecs |

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

### Audit des dépendances

`pnpm audit --audit-level=high` bloquant en CI. Renovate fusionne
automatiquement les mineures **si la CI est verte de bout en bout** ; les
majeures et les alertes de vulnérabilité restent manuelles.

---

## Signaler une vulnérabilité

Ne pas ouvrir d'issue publique. Contacter directement le mainteneur du dépôt.
