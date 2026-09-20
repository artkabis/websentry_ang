import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database.service.js';

/** Ligne brute de `settings_profiles`. */
export interface ProfileRow extends RowDataPacket {
  gamme: string;
  label: string;
  description: string | null;
  /** Colonne JSON : le driver peut rendre un objet déjà décodé ou une chaîne. */
  settings: unknown;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

/** Ligne de métadonnées — sans les réglages, pour les listes. */
export interface ProfileMetaRow extends RowDataPacket {
  gamme: string;
  label: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

const META_COLUMNS = 'gamme, label, description, version, created_at, updated_at, updated_by';

/**
 * Accès à la table `settings_profiles`.
 *
 * Toutes les requêtes sont paramétrées. Le nom de gamme, en particulier, ne
 * construit plus aucun chemin : il ne circule que comme valeur liée.
 */
@Injectable()
export class ProfileRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  /** Liste les profils, `default` d'abord puis par ordre alphabétique. */
  list(): Promise<ProfileMetaRow[]> {
    return this.db.query<ProfileMetaRow>(
      `SELECT ${META_COLUMNS}
         FROM settings_profiles
        ORDER BY (gamme = 'default') DESC, gamme ASC`,
    );
  }

  findByGamme(gamme: string): Promise<ProfileRow | null> {
    return this.db.queryOne<ProfileRow>(
      `SELECT ${META_COLUMNS}, settings
         FROM settings_profiles
        WHERE gamme = ?
        LIMIT 1`,
      [gamme],
    );
  }

  /**
   * Crée un profil. Échoue si la gamme existe déjà (clé primaire).
   *
   * @returns `true` si la ligne a été créée, `false` si elle existait déjà.
   */
  async create(
    gamme: string,
    label: string,
    description: string | null,
    settings: unknown,
    updatedBy: string | null,
  ): Promise<boolean> {
    // `INSERT IGNORE` plutôt qu'un SELECT préalable : le contrôle d'existence et
    // l'insertion sont alors une seule opération, sans fenêtre de course.
    const affected = await this.db.execute(
      `INSERT IGNORE INTO settings_profiles (gamme, label, description, settings, version, updated_by)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [gamme, label, description, JSON.stringify(settings), updatedBy],
    );
    return affected > 0;
  }

  /**
   * Met à jour un profil sous condition de version — c'est le verrouillage
   * optimiste, et il est ATOMIQUE : la comparaison de version et l'incrément
   * sont dans la même instruction, donc indivisibles.
   *
   * @param expectedVersion version lue par le client, ou `null` pour écraser
   *                        sans condition (import délibéré).
   * @returns `true` si la ligne a été mise à jour, `false` si la version ne
   *          correspondait pas ou si la gamme n'existe pas.
   */
  async updateWithVersion(
    gamme: string,
    label: string,
    description: string | null,
    settings: unknown,
    updatedBy: string | null,
    expectedVersion: number | null,
  ): Promise<boolean> {
    const base = `UPDATE settings_profiles
                     SET label = ?, description = ?, settings = ?, updated_by = ?,
                         version = version + 1
                   WHERE gamme = ?`;

    const params: Array<string | number | null> = [
      label,
      description,
      JSON.stringify(settings),
      updatedBy,
      gamme,
    ];

    if (expectedVersion === null) {
      return (await this.db.execute(base, params)) > 0;
    }

    params.push(expectedVersion);
    return (await this.db.execute(`${base} AND version = ?`, params)) > 0;
  }

  /**
   * Supprime un profil.
   *
   * La protection du profil `default` est appliquée en amont par le service ;
   * elle est répétée ici en garde SQL pour qu'aucun appelant ne puisse la
   * contourner, quelle que soit la façon dont il atteint le repository.
   */
  async delete(gamme: string): Promise<boolean> {
    const affected = await this.db.execute(
      `DELETE FROM settings_profiles WHERE gamme = ? AND gamme <> 'default'`,
      [gamme],
    );
    return affected > 0;
  }

  /** Version courante d'un profil, ou `null` s'il n'existe pas. */
  async currentVersion(gamme: string): Promise<number | null> {
    const row = await this.db.queryOne<ProfileMetaRow>(
      'SELECT version FROM settings_profiles WHERE gamme = ? LIMIT 1',
      [gamme],
    );
    return row?.version ?? null;
  }
}
