-- ─────────────────────────────────────────────────────────────────────────────
-- WebSentry v2 — historique des scans
--
-- Le modèle est REPRIS DE LA v1, qui tourne en production : les tables `sites`,
-- `scan_sessions` et `scan_pages` existent déjà et contiennent des données. La
-- v2 les lit telles quelles — c'est ce qui rend l'historique utilisable dès le
-- premier déploiement, sans reprise de données ni double écriture.
--
--   sites          un couple (domaine, gamme) — identité stable dans le temps
--     └─ scan_sessions   un lancement d'audit (scan unique ou batch)
--          └─ scan_pages   une URL analysée, qui porte le rapport complet
--
-- Ce fichier est donc à la fois la création initiale (CREATE TABLE IF NOT EXISTS,
-- pour une base neuve) et la migration additive d'une base v1 (ALTER ... ADD
-- COLUMN IF NOT EXISTS, pour la colonne que la v2 ajoute). Rien n'est supprimé
-- ni renommé : une v1 et une v2 peuvent lire la même base pendant la bascule,
-- ce que le mode « strangler » exige.
--
-- Application : mysql -u websentry -p websentry < 003-scan-history.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── sites ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sites (

  id            CHAR(36)      NOT NULL,

  -- Hostname, ou `hote/site/{uuid}` pour les URL de prévisualisation Duda, qui
  -- partagent un hôte commun : l'identité du site y vit dans le chemin.
  domain        VARCHAR(255)  NOT NULL,

  gamme         VARCHAR(50)   DEFAULT NULL,

  -- Clé d'identité dérivée — `domain|gamme`, gamme absente → `domain|`.
  -- Un UNIQUE (domain, gamme) ne suffirait PAS : deux NULL n'étant jamais égaux
  -- en SQL, le site « sans gamme » serait dupliqué à chaque scan.
  identity_key  VARCHAR(320)  AS (CONCAT(domain, '|', COALESCE(gamme, ''))) STORED,

  epj           VARCHAR(100)  DEFAULT NULL,
  site_alias    VARCHAR(255)  DEFAULT NULL,
  metadata      JSON          DEFAULT NULL,

  first_seen    DATETIME      NOT NULL,
  last_seen     DATETIME      NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_identity (identity_key),
  INDEX idx_sites_domain    (domain),
  INDEX idx_sites_gamme     (gamme),
  INDEX idx_sites_epj       (epj),
  INDEX idx_sites_last_seen (last_seen DESC),
  FULLTEXT INDEX ft_site (domain, epj)

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Sites audités — identité = couple (domaine, gamme)';

-- ─── scan_sessions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scan_sessions (

  -- Identifiant du LANCEMENT : pour un batch, toutes les pages le partagent.
  id            CHAR(36)      NOT NULL,
  site_id       CHAR(36)      NOT NULL,

  -- Gamme / EPJ / plateforme au moment du scan. Dénormalisés à dessein : ils
  -- décrivent l'état du site CE JOUR-LÀ, que le site ait changé depuis ou non.
  gamme         VARCHAR(50)   DEFAULT NULL,
  epj           VARCHAR(100)  DEFAULT NULL,
  platform      VARCHAR(50)   DEFAULT NULL,

  -- Agrégats précalculés sur les pages — évitent un GROUP BY sur scan_pages
  -- à chaque affichage de liste.
  page_count    INT           NOT NULL DEFAULT 0,
  avg_score     DECIMAL(5,2)  DEFAULT NULL,
  min_score     DECIMAL(5,2)  DEFAULT NULL,
  max_score     DECIMAL(5,2)  DEFAULT NULL,

  analyzed_at   DATETIME      NOT NULL,
  duration_ms   INT           DEFAULT NULL,

  launched_by   VARCHAR(64)   DEFAULT NULL,

  -- Réglages actifs au moment du scan. Sans eux, un résultat ancien n'est plus
  -- interprétable : on ne saurait pas quels critères étaient seulement actifs.
  profile_snapshot JSON       DEFAULT NULL,

  metadata      JSON          DEFAULT NULL,

  PRIMARY KEY (id),
  INDEX idx_sessions_site        (site_id),
  INDEX idx_sessions_analyzed_at (analyzed_at DESC),
  INDEX idx_sessions_avg_score   (avg_score),
  INDEX idx_sessions_launched_by (launched_by),
  CONSTRAINT fk_session_site
    FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Sessions de scan — un lancement (batch ou scan unique)';

-- ─── scan_pages ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scan_pages (

  id            CHAR(36)      NOT NULL,
  session_id    CHAR(36)      NOT NULL,

  url           VARCHAR(2048) NOT NULL,
  domain        VARCHAR(255)  NOT NULL,

  global_score  DECIMAL(5,2)  DEFAULT NULL,
  status_code   SMALLINT      DEFAULT NULL,

  analyzed_at   DATETIME      NOT NULL,
  duration_ms   INT           DEFAULT NULL,

  -- Résumé {critère → statut}. TOUJOURS présent, y compris après purge du
  -- rapport : c'est lui qui permet de comparer deux scans anciens.
  check_summary JSON          NOT NULL,

  -- ── Stockage du rapport, à trois étages ────────────────────────────────────
  -- récent  : `report` en clair, lecture immédiate
  -- ancien  : `report_gz` compressé, 7 à 10 fois plus compact
  -- purgé   : ni l'un ni l'autre, `report_purged_at` daté
  report        MEDIUMTEXT    DEFAULT NULL,
  report_gz     MEDIUMBLOB    DEFAULT NULL,
  is_compressed TINYINT(1)    NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  INDEX idx_pages_session     (session_id),
  INDEX idx_pages_url         (url(191)),
  INDEX idx_pages_analyzed_at (analyzed_at DESC),
  INDEX idx_pages_score       (global_score),
  INDEX idx_pages_compress    (is_compressed, analyzed_at),
  CONSTRAINT fk_page_session
    FOREIGN KEY (session_id) REFERENCES scan_sessions (id) ON DELETE CASCADE

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Pages analysées — stockage à trois étages (clair / compressé / purgé)';

-- ─── Migration additive depuis la v1 ─────────────────────────────────────────
--
-- `report_purged_at` distingue « rapport effacé par la rétention » de « rapport
-- jamais écrit ». La v1 confondait les deux : après purge elle remettait
-- `is_compressed = 0` et vidait les deux colonnes, rendant la ligne identique à
-- une page sans rapport. L'API répondait alors 404 « scan introuvable » — faux,
-- puisque le scan existe, et trompeur, puisque l'utilisateur part chercher une
-- donnée que l'application a elle-même supprimée. La v2 répond 410 Gone et dit
-- quand la purge a eu lieu.
--
-- Colonne NULLABLE et sans valeur par défaut : les lignes v1 déjà purgées
-- restent à NULL. Elles se comportent comme aujourd'hui (rapport indisponible,
-- date inconnue) au lieu de se voir attribuer une date de purge inventée.

ALTER TABLE scan_pages
  ADD COLUMN IF NOT EXISTS report_purged_at DATETIME DEFAULT NULL
  COMMENT 'Date de purge du rapport par la rétention — NULL si jamais purgé';

ALTER TABLE scan_pages
  ADD INDEX IF NOT EXISTS idx_pages_purged (report_purged_at);
