-- ═════════════════════════════════════════════════════════════════════════════
-- Corbeille des scans supprimés
--
-- La v1 conserve les suppressions en masse dans une table d'archive avant purge,
-- avec restauration et export. Le module 3 de la v2 a livré les quatre portées
-- de suppression SANS ce filet, ce qui a eu une conséquence visible :
-- l'interface ne les propose pas, parce qu'offrir l'effacement définitif d'un
-- domaine entier en un clic serait imprudent. La corbeille rétablit la capacité
-- v1 et débloque l'interface.
--
-- ── Pourquoi une archive et non un `deleted_at` ──────────────────────────────
-- Un marqueur de suppression logique obligerait CHAQUE lecture de l'historique
-- à le filtrer. Un filtre oublié ne casse rien de visible : il laisse remonter
-- des lignes supprimées, et personne ne s'en aperçoit. L'archive, elle, ne
-- touche à aucun chemin de lecture — le SQL de l'historique reste exactement
-- celui qui est testé aujourd'hui.
--
-- Le coût est un doublon de stockage, borné dans le temps par `purge_after` et
-- réduit par la compression : un instantané gzippé pèse environ un dixième des
-- lignes qu'il remplace, les rapports de page se comprimant 7 à 10 fois.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scan_trash (

  id              CHAR(36)      NOT NULL,

  -- Le GESTE qui a produit l'entrée : une session, un site (couple domaine +
  -- gamme), ou un domaine entier. Il n'est pas déduit du contenu — deux gestes
  -- différents peuvent produire le même instantané, et l'utilisateur cherche
  -- ce qu'il a fait, pas ce que la base en a retenu.
  scope           VARCHAR(16)   NOT NULL,

  -- Identité lisible de la cible, pour lister sans décompresser l'instantané.
  domain          VARCHAR(255)  NOT NULL,
  gamme           VARCHAR(50)   DEFAULT NULL,
  label           VARCHAR(320)  NOT NULL,

  session_count   INT           NOT NULL,
  page_count      INT           NOT NULL,

  -- Instantané complet : sites, sessions et pages, en JSON gzippé.
  --
  -- Les lignes sont capturées par `SELECT *` et non par une liste de colonnes
  -- écrite à la main : une colonne ajoutée plus tard à `scan_pages` serait
  -- sinon perdue à la restauration, sans que rien ne le signale. Un test
  -- compare les clés de l'instantané au schéma réel.
  payload_gz      LONGBLOB      NOT NULL,

  -- Taille de l'instantané AVANT compression — la supervision doit pouvoir dire
  -- ce que la corbeille coûte sans tout décompresser.
  payload_bytes   INT UNSIGNED  NOT NULL,

  deleted_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- L'auteur de la suppression. `SET NULL` et non `CASCADE` : le départ d'un
  -- compte ne doit pas effacer la corbeille, qui appartient à l'équipe.
  deleted_by      CHAR(36)      DEFAULT NULL,
  deleted_by_name VARCHAR(64)   DEFAULT NULL,

  -- Au-delà de cette date, la rétention efface l'entrée définitivement. Datée à
  -- l'écriture plutôt que calculée à la lecture : allonger la durée ne doit pas
  -- ressusciter une entrée que l'équipe croyait déjà partie.
  purge_after     DATETIME      NOT NULL,

  PRIMARY KEY (id),
  INDEX idx_trash_deleted (deleted_at DESC),
  INDEX idx_trash_purge   (purge_after),
  INDEX idx_trash_domain  (domain),

  CONSTRAINT chk_trash_scope CHECK (scope IN ('session', 'site', 'domain')),

  CONSTRAINT fk_trash_actor
    FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE SET NULL

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Corbeille des scans supprimés — restauration et export avant purge';
