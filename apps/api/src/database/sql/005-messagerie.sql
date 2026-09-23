-- ─────────────────────────────────────────────────────────────────────────────
-- WebSentry v2 — messagerie in-app
--
-- Trois tables NOUVELLES. Le fichier reste écrit comme les précédents — CREATE
-- TABLE IF NOT EXISTS, aucune suppression ni renommage — pour qu'une v1 et une
-- v2 puissent lire la même base pendant la bascule.
--
-- Application : mysql -u websentry -p websentry < 005-messagerie.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Le message, écrit UNE fois ───────────────────────────────────────────────
--
-- Le corps n'est pas recopié par destinataire : une annonce envoyée à quarante
-- comptes s'écrit une fois, et se corrige au même endroit.

CREATE TABLE IF NOT EXISTS messages (

  id             CHAR(36)      NOT NULL,

  subject        VARCHAR(150)  NOT NULL,
  -- 10 000 caractères côté schéma applicatif ; TEXT laisse la marge sans
  -- contrainte de ligne, et la borne reste posée par Zod, au seul endroit où
  -- elle est lisible par les deux côtés.
  body           TEXT          NOT NULL,

  importance     VARCHAR(20)   NOT NULL DEFAULT 'normale',

  -- L'audience est conservée pour le JOURNAL, pas pour la lecture : les
  -- destinataires sont résolus à l'envoi, dans `message_recipients`. Savoir
  -- qu'un envoi visait « le rang 50 » reste utile pour relire ce qui a été
  -- décidé, une fois les comptes modifiés.
  audience       VARCHAR(20)   NOT NULL,
  audience_rank  INT           DEFAULT NULL,

  -- L'auteur peut disparaître ; son message, non. La clé étrangère passe donc
  -- à NULL, et `author_name` garde la trace de qui a écrit.
  author_id      CHAR(36)      DEFAULT NULL,
  author_name    VARCHAR(64)   DEFAULT NULL,

  sent_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  KEY idx_messages_envoi (sent_at),

  CONSTRAINT fk_messages_author
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL,

  -- Les valeurs admises sont énoncées ICI EN PLUS de Zod : la base est la
  -- dernière ligne, et elle tient même si une écriture arrive d'ailleurs.
  CONSTRAINT chk_messages_importance
    CHECK (importance IN ('normale', 'haute', 'critique')),
  CONSTRAINT chk_messages_audience
    CHECK (audience IN ('tous', 'rang', 'comptes')),
  -- Un rang visé n'a de sens que pour une audience par rang, et il doit
  -- appartenir au catalogue : `chk_rank` vaut pour les comptes, celle-ci pour
  -- la cible d'un envoi.
  CONSTRAINT chk_messages_rang_cible
    CHECK (
      (audience = 'rang' AND audience_rank IN (10, 30, 50, 100))
      OR (audience <> 'rang' AND audience_rank IS NULL)
    )

) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;


-- ── L'état de lecture, qui appartient au DESTINATAIRE ────────────────────────
--
-- Deux comptes lisent le même envoi, chacun avec son `read_at`. Mettre cet
-- état sur le message ferait du premier lecteur celui qui marque pour tous.
--
-- La clé primaire composite interdit le doublon de destinataire : un même
-- compte ne peut pas recevoir deux fois le même message, quelle que soit la
-- façon dont l'audience a été résolue.

CREATE TABLE IF NOT EXISTS message_recipients (

  message_id     CHAR(36)      NOT NULL,
  user_id        CHAR(36)      NOT NULL,

  read_at        TIMESTAMP     NULL DEFAULT NULL,
  archived_at    TIMESTAMP     NULL DEFAULT NULL,

  PRIMARY KEY (message_id, user_id),

  -- La boîte se lit par destinataire, du plus récent au plus ancien : cet
  -- index porte l'essentiel des lectures, pastille de non-lus comprise.
  KEY idx_destinataires_boite (user_id, archived_at, read_at),

  -- Supprimer un message emporte ses destinataires : un état de lecture sans
  -- message à lire ne veut rien dire.
  CONSTRAINT fk_destinataires_message
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  -- Supprimer un compte emporte sa boîte : elle lui était personnelle.
  CONSTRAINT fk_destinataires_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE

) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;


-- ── Les pièces jointes — métadonnées seulement ───────────────────────────────
--
-- Le fichier lui-même est rangé hors base, sous un nom DÉRIVÉ DE `id`, qui est
-- généré par le serveur. Le nom fourni par l'appelant ne sert qu'à l'affichage
-- et à l'en-tête de téléchargement : il n'entre jamais dans un chemin.
--
-- Stocker le binaire en base aurait rendu chaque lecture de message plus
-- lourde et chaque sauvegarde démesurée, pour un gain qui ne se manifeste que
-- si l'on perd le disque sans perdre la base.

CREATE TABLE IF NOT EXISTS message_attachments (

  id             CHAR(36)      NOT NULL,
  message_id     CHAR(36)      NOT NULL,

  -- Nom d'origine, DÉJÀ nettoyé à l'écriture (séparateurs, caractères de
  -- contrôle, guillemets). Le nettoyer à la lecture seulement laisserait une
  -- ligne empoisonnée en base, prête pour le premier lecteur distrait.
  nom            VARCHAR(120)  NOT NULL,

  -- Type RECONNU à l'empreinte du fichier, jamais celui annoncé par
  -- l'appelant.
  mime           VARCHAR(100)  NOT NULL,
  taille         INT UNSIGNED  NOT NULL,

  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  KEY idx_pieces_message (message_id),

  CONSTRAINT fk_pieces_message
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,

  -- La liste blanche est répétée en base : une écriture qui n'emprunterait pas
  -- le service ne peut pas y déposer un type exécutable.
  CONSTRAINT chk_pieces_mime
    CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
  -- 5 Mio, la même borne que le schéma partagé.
  CONSTRAINT chk_pieces_taille
    CHECK (taille > 0 AND taille <= 5242880)

) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
