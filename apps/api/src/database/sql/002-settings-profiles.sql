-- ─────────────────────────────────────────────────────────────────────────────
-- WebSentry v2 — profils de réglages par gamme
--
-- ÉCART ASSUMÉ par rapport à la v1, qui stockait un fichier `settings-{gamme}.json`
-- par gamme sur disque. Le passage en base corrige trois défauts de ce modèle :
--
--   1. Le verrouillage optimiste de la v1 lisait la version, comparait, puis
--      réécrivait — une fenêtre de course entre les deux. Ici, la condition et
--      l'incrément sont dans le MÊME `UPDATE`, donc atomiques.
--   2. Le cache TTL de 5 minutes servait des profils périmés derrière un
--      répartiteur de charge : chaque instance avait sa propre vue du disque.
--   3. Le nom de gamme ne construit plus un chemin de fichier : la traversée de
--      chemin disparaît comme surface, au lieu d'être contenue par une
--      normalisation à maintenir.
--
-- Le format fichier reste accessible via les endpoints d'export/import, pour
-- versionner un profil dans Git ou le rejouer d'un environnement à l'autre.
--
-- Application : mysql -u websentry -p websentry < 002-settings-profiles.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings_profiles (

  -- Gamme NORMALISÉE (minuscules, alphanumérique et tirets). Clé primaire :
  -- un profil par gamme, l'unicité est structurelle.
  gamme        VARCHAR(50)   NOT NULL,

  label        VARCHAR(120)  NOT NULL,
  description  VARCHAR(1000) DEFAULT NULL,

  -- Réglages complets, validés par Zod AVANT écriture et À la relecture.
  settings     JSON          NOT NULL,

  -- Verrouillage optimiste : incrémentée dans le même UPDATE que la condition
  -- `WHERE version = ?`. Deux écritures concurrentes ne peuvent pas toutes deux
  -- réussir — la seconde touche 0 ligne et remonte un conflit.
  version      INT UNSIGNED  NOT NULL DEFAULT 1,

  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  updated_by   VARCHAR(64)   DEFAULT NULL,

  PRIMARY KEY (gamme),
  INDEX idx_profiles_updated (updated_at DESC),

  -- Dernier rempart : même si un appelant contournait la normalisation
  -- applicative, la base refuse une gamme hors de l'alphabet attendu.
  CONSTRAINT chk_profile_gamme CHECK (gamme REGEXP '^[a-z0-9-]+$'),
  CONSTRAINT chk_profile_version CHECK (version >= 0)

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Profils de réglages par gamme — `default` est le repli universel';
