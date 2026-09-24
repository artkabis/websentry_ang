---
titre: Profils par gamme
section: Prise en main
ordre: 2
---

Un profil décrit ce qu'on attend d'un site : quels critères comptent, combien
ils pèsent, et quels seuils séparent un résultat acceptable d'un résultat
insuffisant. Chaque gamme a le sien.

## Ce qu'un profil contient

- **Critères actifs** — la liste de ce qui est vérifié.
- **Pondérations** — le poids de chaque critère dans le score.
- **Mots exclus des titres** — les mots-outils qu'on ne compte pas.
- **Domaines non vérifiés** — les hôtes qu'on ne va pas interroger.
- **Règles par page** — les exceptions nommées, page par page.

L'éditeur replie chaque section et affiche un résumé chiffré sur son en-tête :
on sait ce qu'on n'ouvre pas.

## Modifier un profil sans casser l'historique

Un profil modifié ne réécrit PAS les scans déjà enregistrés. Chaque scan
conserve le profil qui était actif au moment où il a été lancé — sans quoi un
résultat ancien deviendrait illisible.

> Note: la modification d'un profil est enregistrée au journal d'audit, avec
> son auteur et la date.

## Verrouillage optimiste

Si deux personnes ouvrent le même profil et l'enregistrent, la seconde reçoit
un refus plutôt que d'écraser le travail de la première. L'écran propose alors
de recharger pour repartir de la version à jour.
