import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService, type SqlParam } from '../database.service.js';

/**
 * Retours des bêta-testeurs.
 *
 * Chaque requête est paramétrée : aucune valeur d'entrée n'est interpolée dans
 * le texte SQL. Le nom de l'auteur et celui de l'assigné sont ramenés par
 * jointure GAUCHE — un compte supprimé met la clé à NULL, et le retour doit
 * rester lisible.
 */

export interface FeedbackRow extends RowDataPacket {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  context: unknown;
  author_id: string | null;
  author_name: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const COLONNES = `f.id, f.kind, f.severity, f.status, f.title, f.body, f.context,
                  f.author_id, f.author_name, f.assigned_to, f.resolution,
                  f.created_at, f.updated_at, f.resolved_at,
                  a.username AS assigned_name`;

const JOINTURE = 'LEFT JOIN users a ON a.id = f.assigned_to';

export interface FeedbackFilters {
  status?: string;
  kind?: string;
  severity?: string;
  search?: string;
  /** Restreint aux retours d'un auteur — c'est le garde-fou de visibilité. */
  authorId?: string;
}

@Injectable()
export class FeedbackRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /**
   * Filtre commun à la liste, au comptage et aux compteurs par statut.
   *
   * Une seule fabrique pour les trois : trois constructions séparées
   * finiraient par diverger, et le total annoncé ne correspondrait plus aux
   * lignes affichées.
   */
  private static filtre(filtres: FeedbackFilters): { where: string; params: SqlParam[] } {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    if (filtres.status) {
      clauses.push('f.status = ?');
      params.push(filtres.status);
    }
    if (filtres.kind) {
      clauses.push('f.kind = ?');
      params.push(filtres.kind);
    }
    if (filtres.severity) {
      clauses.push('f.severity = ?');
      params.push(filtres.severity);
    }
    if (filtres.authorId) {
      clauses.push('f.author_id = ?');
      params.push(filtres.authorId);
    }
    if (filtres.search) {
      clauses.push('(f.title LIKE ? OR f.body LIKE ?)');
      // Les jokers sont posés ICI, sur une valeur paramétrée : les concaténer
      // dans le texte SQL rouvrirait l'injection que le « ? » ferme.
      const motif = `%${filtres.search}%`;
      params.push(motif, motif);
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  list(filtres: FeedbackFilters, limit: number, offset: number): Promise<FeedbackRow[]> {
    const { where, params } = FeedbackRepository.filtre(filtres);
    return this.db.query<FeedbackRow>(
      `SELECT ${COLONNES} FROM feedback f ${JOINTURE} ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async count(filtres: FeedbackFilters): Promise<number> {
    const { where, params } = FeedbackRepository.filtre(filtres);
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM feedback f ${where}`,
      params,
    );
    return ligne?.total ?? 0;
  }

  /** Compteurs par statut — l'en-tête de triage les affiche tous, zéros compris. */
  countByStatus(filtres: FeedbackFilters = {}): Promise<RowDataPacket[]> {
    const { where, params } = FeedbackRepository.filtre(filtres);
    return this.db.query<RowDataPacket>(
      `SELECT f.status, COUNT(*) AS total FROM feedback f ${where} GROUP BY f.status`,
      params,
    );
  }

  findById(id: string): Promise<FeedbackRow | null> {
    return this.db.queryOne<FeedbackRow>(
      `SELECT ${COLONNES} FROM feedback f ${JOINTURE} WHERE f.id = ?`,
      [id],
    );
  }

  async create(retour: {
    id: string;
    kind: string;
    severity: string;
    title: string;
    body: string;
    context: unknown;
    authorId: string | null;
    authorName: string | null;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO feedback (id, kind, severity, status, title, body, context, author_id, author_name)
       VALUES (?, ?, ?, 'nouveau', ?, ?, ?, ?, ?)`,
      [
        retour.id,
        retour.kind,
        retour.severity,
        retour.title,
        retour.body,
        retour.context === null ? null : JSON.stringify(retour.context),
        retour.authorId,
        retour.authorName,
      ],
    );
  }

  /**
   * Applique les champs fournis, et eux seuls.
   *
   * `resolved_at` suit le statut et n'est jamais posé par l'appelant : le
   * laisser écrire permettrait d'horodater une résolution qui n'a pas eu lieu.
   */
  async triage(
    id: string,
    champs: Partial<{
      status: string;
      severity: string;
      assigned_to: string | null;
      resolution: string | null;
    }>,
  ): Promise<number> {
    const entrees: [string, SqlParam][] = [];
    for (const [colonne, valeur] of Object.entries(champs)) {
      if (valeur !== undefined) entrees.push([colonne, valeur]);
    }
    if (entrees.length === 0) return 0;

    // `resolved_at` est dérivé du statut, par le SQL lui-même : deux écritures
    // séparées pourraient diverger si la seconde échouait.
    const horodatage =
      champs.status === undefined
        ? ''
        : ", resolved_at = CASE WHEN ? = 'resolu' THEN NOW() ELSE NULL END";
    const paramsHorodatage: SqlParam[] = champs.status === undefined ? [] : [champs.status];

    // Les noms de colonnes viennent d'un objet TYPÉ, jamais de l'entrée
    // utilisateur : seules les valeurs passent par « ? ».
    return this.db.execute(
      `UPDATE feedback SET ${entrees.map(([c]) => `${c} = ?`).join(', ')}${horodatage}
        WHERE id = ?`,
      [...entrees.map(([, v]) => v), ...paramsHorodatage, id],
    );
  }
}
