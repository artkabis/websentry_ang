-- ─────────────────────────────────────────────────────────────────────────────
-- WebSentry v2 — retours des bêta-testeurs
--
-- Table NOUVELLE : la v1 collectait ses retours hors de l'application, et rien
-- n'est donc à reprendre. Le fichier reste écrit comme les précédents — CREATE
-- TABLE IF NOT EXISTS, aucune suppression ni renommage — pour qu'une v1 et une
-- v2 puissent lire la même base pendant la bascule.
--
-- Application : mysql -u websentry -p websentry < 004-feedback.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (

  id            CHAR(36)      NOT NULL,

  kind          VARCHAR(20)   NOT NULL,
  severity      VARCHAR(20)   NOT NULL,
  status        VARCHAR(20)   NOT NULL DEFAULT 'nouveau',

  title         VARCHAR(150)  NOT NULL,
  -- 5000 caractères côté schéma applicatif ; TEXT laisse la marge sans
  -- contrainte de ligne, et la borne reste posée par Zod, au seul endroit où
  -- elle est lisible par les deux côtés.
  body          TEXT          NOT NULL,

  -- Contexte capturé automatiquement (route, URL auditée, gamme). JSON plutôt
  -- que trois colonnes : il s'enrichira, et chaque enrichissement coûterait
  -- sinon une migration pour une donnée que personne n'interroge en SQL.
  context       JSON          DEFAULT NULL,

  -- L'auteur peut disparaître ; son retour, non. La clé étrangère passe donc à
  -- NULL, et `author_name` garde la trace de qui a signalé.
  author_id     CHAR(36)      DEFAULT NULL,
  author_name   VARCHAR(64)   DEFAULT NULL,

  assigned_to   CHAR(36)      DEFAULT NULL,

  -- Réponse rendue à l'auteur : c'est elle qui ferme la boucle. Sans elle, un
  -- retour « rejeté » ne dit pas pourquoi, et le testeur cesse d'en déposer.
  resolution    TEXT          DEFAULT NULL,

  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at   TIMESTAMP     NULL DEFAULT NULL,

  PRIMARY KEY (id),

  -- L'écran de triage lit par statut, la vue « mes retours » par auteur : ces
  -- deux index portent l'essentiel des lectures.
  KEY idx_feedback_status  (status, created_at),
  KEY idx_feedback_author  (author_id, created_at),
  KEY idx_feedback_assigne (assigned_to, status),

  CONSTRAINT fk_feedback_author
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_feedback_assigne
    FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,

  -- Les valeurs admises sont énoncées ICI EN PLUS de Zod : la base est la
  -- dernière ligne, et elle tient même si une écriture arrive d'ailleurs.
  CONSTRAINT chk_feedback_kind
    CHECK (kind IN ('bug', 'suggestion', 'question')),
  CONSTRAINT chk_feedback_severity
    CHECK (severity IN ('bloquant', 'majeur', 'mineur', 'cosmetique')),
  CONSTRAINT chk_feedback_status
    CHECK (status IN ('nouveau', 'accepte', 'en_cours', 'resolu', 'rejete'))

) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
