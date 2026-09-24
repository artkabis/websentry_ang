---
titre: Données personnelles
section: Gouvernance
ordre: 1
---

WebSentry conserve peu de données sur ses utilisateurs, et l'écran **Usage** en
affiche le registre complet, produit par le code lui-même.

## Ce qui est conservé

- Le **compte** : identifiant, nom affiché, adresse de courriel.
- Le **journal d'audit** : qui a fait quoi, quand, et depuis quelle adresse IP.
- L'**historique des scans** : le nom du compte ayant lancé chaque analyse.

Les statistiques d'usage ne reposent sur aucune collecte supplémentaire : elles
sont calculées à partir de ces tables, qui existent déjà pour d'autres raisons.

## Combien de temps

Passé le délai de conservation, une entrée du journal d'audit perd son
identifiant, son nom et son adresse IP. L'action, sa cible et sa date restent :
ce sont elles qui font du journal une preuve.

> Note: la suppression d'un compte anonymise immédiatement ses traces, sans
> attendre ce délai.

## Ce que les statistiques ne montrent jamais

Aucun écran d'usage ne nomme une personne. Les compteurs portent sur des
comptes distincts, et un compteur trop petit s'affiche « moins de 5 » plutôt
que de désigner quelqu'un.

Pour savoir qui a fait quoi, il faut le **journal d'audit**, réservé au rang le
plus élevé — et sa consultation est elle-même tracée.
