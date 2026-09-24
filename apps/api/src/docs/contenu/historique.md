---
titre: Historique des scans
section: Au quotidien
ordre: 1
---

L'historique conserve ce qu'était l'état d'un site à une date donnée. C'est une
base de preuve : on s'y réfère pour dire ce qui a changé, et quand.

## Ce qu'on peut en faire

- Retrouver les scans d'un site, du plus récent au plus ancien.
- Comparer deux scans et voir ce qui a bougé, critère par critère.
- Filtrer par gamme, par score ou par période — les filtres sont dans l'URL,
  donc une recherche se partage par simple copie du lien.

## Ce qu'on ne peut PAS en faire

Aucune route ne permet d'ajouter un scan à l'historique depuis l'extérieur.
L'écriture se fait uniquement en interne, au moment où une analyse se termine.

> Attention: un point d'entrée d'ingestion offrirait le moyen de fabriquer un
> passé — des audits qui n'ont jamais eu lieu. C'est précisément ce que
> l'absence de porte empêche.

## Conservation

Les rapports anciens sont compressés, puis purgés au-delà d'un certain délai.
Le résumé des critères survit à la purge : la comparaison entre deux scans
anciens reste possible longtemps après la disparition de leur détail.
