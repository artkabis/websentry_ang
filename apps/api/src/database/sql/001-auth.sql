-- ─────────────────────────────────────────────────────────────────────────────
-- WebSentry v2 — schéma d'authentification et d'autorisation
--
-- Repris à l'IDENTIQUE de la v1 : les comptes existants doivent continuer à se
-- connecter après bascule, ce qui interdit toute modification du format de
-- `password_hash` comme de la sémantique de `rank`.
--
-- Application : mysql -u websentry -p websentry < 001-auth.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                   CHAR(36)         NOT NULL,
  username             VARCHAR(64)      NOT NULL,
  password_hash        VARCHAR(255)     NOT NULL,
  display_name         VARCHAR(128)     DEFAULT NULL,
  email                VARCHAR(255)     DEFAULT NULL,

  rank                 TINYINT UNSIGNED NOT NULL DEFAULT 10,
  status               ENUM('active','suspended','pending') NOT NULL DEFAULT 'pending',

  -- Incrémentée pour révoquer d'un coup TOUS les access tokens du compte,
  -- sans attendre leur expiration.
  token_version        INT UNSIGNED     NOT NULL DEFAULT 0,
  failed_logins        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- Verrou PERSISTÉ : il survit au redémarrage et à la répartition de charge,
  -- contrairement à un compteur en mémoire.
  locked_until         DATETIME         DEFAULT NULL,
  total_scans_launched INT UNSIGNED     NOT NULL DEFAULT 0,

  created_at           DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
  created_by           CHAR(36)         DEFAULT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username),
  UNIQUE KEY uk_email    (email),
  INDEX idx_rank         (rank),
  INDEX idx_status       (status),
  -- Les rangs sont un ensemble FERMÉ : la contrainte empêche qu'une valeur
  -- intermédiaire inventée contourne les seuils de garde.
  CONSTRAINT chk_rank CHECK (rank IN (10, 30, 50, 100))
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Utilisateurs — super_admin(100) admin(50) editor(30) tester(10)';

-- ─── user_permissions ────────────────────────────────────────────────────────
-- Une ligne = un code de permission + scope de gammes optionnel (NULL = toutes).
CREATE TABLE IF NOT EXISTS user_permissions (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  permission VARCHAR(64)  NOT NULL,
  gammes     JSON         DEFAULT NULL,
  granted_by CHAR(36)     NOT NULL,
  granted_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL = permanent. Un grant expiré reste en base mais devient inactif :
  -- le filtre est appliqué côté SQL, donc aucun appelant ne peut l'oublier.
  expires_at DATETIME     DEFAULT NULL,

  UNIQUE KEY uk_user_perm (user_id, permission),
  INDEX idx_perm_expires  (expires_at),
  CONSTRAINT fk_perm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Permissions fines par utilisateur, avec scope de gammes optionnel';

-- ─── user_sessions ───────────────────────────────────────────────────────────
-- Sessions de rafraîchissement. Le jeton BRUT n'est jamais stocké : une fuite de
-- cette table ne permet donc pas de rejouer les sessions.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           CHAR(36)     NOT NULL,
  user_id      CHAR(36)     NOT NULL,
  token_hash   VARCHAR(255) NOT NULL,
  issued_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME     NOT NULL,
  last_used_at DATETIME     DEFAULT NULL,
  ip_address   VARCHAR(45)  DEFAULT NULL,
  user_agent   VARCHAR(512) DEFAULT NULL,
  revoked      TINYINT(1)   NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  INDEX idx_user_sessions_user    (user_id),
  INDEX idx_user_sessions_expires (expires_at),
  CONSTRAINT fk_usession_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Sessions de rafraîchissement (rotation, empreinte SHA-256)';

-- ─── audit_log ───────────────────────────────────────────────────────────────
-- Journal APPEND-ONLY. Aucun UPDATE ni DELETE depuis l'application : le
-- repository correspondant n'expose délibérément aucune méthode pour le faire.
--
-- Durcissement recommandé en production — restreindre aussi les droits SQL :
--   GRANT INSERT, SELECT ON websentry.audit_log TO 'websentry'@'%';
-- La garantie devient alors indépendante du code applicatif.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    CHAR(36)     DEFAULT NULL,
  actor_name  VARCHAR(64)  DEFAULT NULL,
  action      VARCHAR(64)  NOT NULL,
  target_id   CHAR(36)     DEFAULT NULL,
  target_type VARCHAR(32)  DEFAULT NULL,
  details     JSON         DEFAULT NULL,
  ip_address  VARCHAR(45)  DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_audit_actor   (actor_id),
  INDEX idx_audit_action  (action),
  INDEX idx_audit_created (created_at DESC)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Journal d''audit append-only — aucun UPDATE ni DELETE autorisé';
