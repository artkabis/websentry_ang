import { Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { TrashListQuery, TrashScope } from '@websentry/shared';
import { DatabaseService, type SqlParam } from '../database.service.js';
import type { LigneInstantanee } from '../../scans/scan-trash.util.js';

export interface TrashRow extends RowDataPacket {
  id: string;
  scope: TrashScope;
  domain: string;
  gamme: string | null;
  label: string;
  session_count: number;
  page_count: number;
  payload_bytes: number;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
  purge_after: string;
}

/** Ce qu'une entrée transporte réellement — les lignes à réinsérer. */
export interface Instantane {
  sites: LigneInstantanee[];
  sessions: LigneInstantanee[];
  pages: LigneInstantanee[];
}

export interface EntreeAEcrire {
  id: string;
  scope: TrashScope;
  domain: string;
  gamme: string | null;
  label: string;
  sessionCount: number;
  pageCount: number;
  payloadGz: Buffer;
  payloadBytes: number;
  deletedBy: string | null;
  deletedByName: string | null;
  purgeAfterDays: number;
}

export interface Restauration {
  sites: number;
  sessions: number;
  pages: number;
  skippedSessions: number;
}

const COLONNES = `id, scope, domain, gamme, label, session_count, page_count,
                  payload_bytes, deleted_at, deleted_by, deleted_by_name, purge_after`;

/**
 * Accès à la corbeille des scans.
 *
 * Aucune méthode ne touche aux tables de l'historique en lecture : la corbeille
 * est une table à part, et c'est le choix qui préserve tout le SQL de
 * l'historique tel qu'il est testé (cf. `DECISIONS.md` 70). Les seules
 * écritures dans l'historique sont celles de la restauration, et elles passent
 * par une transaction.
 */
@Injectable()
export class ScanTrashRepository {
  constructor(private readonly db: DatabaseService) {}

  get available(): boolean {
    return this.db.enabled;
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /**
   * Lignes à archiver, capturées par `SELECT *`.
   *
   * Pas de liste de colonnes écrite à la main : une colonne ajoutée plus tard à
   * l'historique serait perdue à la restauration, sans que rien ne le signale.
   * Un test compare les clés obtenues au schéma réel.
   */
  async capturer(siteIds: readonly string[], sessionIds: readonly string[]): Promise<Instantane> {
    const sites = siteIds.length > 0 ? await this.lignes('sites', 'id', siteIds) : [];
    const sessions =
      sessionIds.length > 0 ? await this.lignes('scan_sessions', 'id', sessionIds) : [];
    const pages =
      sessionIds.length > 0 ? await this.lignes('scan_pages', 'session_id', sessionIds) : [];
    return { sites, sessions, pages };
  }

  private async lignes(
    table: 'sites' | 'scan_sessions' | 'scan_pages',
    colonne: 'id' | 'session_id',
    valeurs: readonly string[],
  ): Promise<LigneInstantanee[]> {
    // La table et la colonne viennent de tables fermées ; seuls les marqueurs
    // `?` sont dérivés de la LONGUEUR du tableau, jamais de son contenu.
    const marqueurs = valeurs.map(() => '?').join(', ');
    return this.db.query<RowDataPacket & LigneInstantanee>(
      `SELECT * FROM ${table} WHERE ${colonne} IN (${marqueurs})`,
      valeurs,
    );
  }

  /**
   * Identifiant technique d'un site, désigné par son identité.
   *
   * Lu ICI et non dans `ScanRepository` : la corbeille est la seule à en avoir
   * besoin, et ajouter une lecture au dépôt de l'historique pour un usage
   * d'archivage brouillerait la frontière entre les deux.
   */
  async siteParIdentite(domain: string, gamme: string | null): Promise<string | null> {
    const ligne = await this.db.queryOne<RowDataPacket & { id: string }>(
      'SELECT id FROM sites WHERE identity_key = ?',
      [`${domain}|${gamme ?? ''}`],
    );
    return ligne?.id ?? null;
  }

  /** Identifiants des sites d'un domaine, toutes gammes confondues. */
  async sitesDuDomaine(domain: string): Promise<string[]> {
    const lignes = await this.db.query<RowDataPacket & { id: string }>(
      'SELECT id FROM sites WHERE domain = ?',
      [domain],
    );
    return lignes.map(l => l.id);
  }

  /** Identifiants des sessions rattachées à des sites donnés. */
  async sessionsDesSites(siteIds: readonly string[]): Promise<string[]> {
    if (siteIds.length === 0) return [];
    const marqueurs = siteIds.map(() => '?').join(', ');
    const lignes = await this.db.query<RowDataPacket & { id: string }>(
      `SELECT id FROM scan_sessions WHERE site_id IN (${marqueurs})`,
      siteIds,
    );
    return lignes.map(l => l.id);
  }

  // ── Écriture et lecture de la corbeille ────────────────────────────────────

  async ajouter(entree: EntreeAEcrire): Promise<void> {
    await this.db.execute(
      `INSERT INTO scan_trash
         (id, scope, domain, gamme, label, session_count, page_count,
          payload_gz, payload_bytes, deleted_by, deleted_by_name, purge_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        entree.id,
        entree.scope,
        entree.domain,
        entree.gamme,
        entree.label,
        entree.sessionCount,
        entree.pageCount,
        entree.payloadGz,
        entree.payloadBytes,
        entree.deletedBy,
        entree.deletedByName,
        entree.purgeAfterDays,
      ],
    );
  }

  private filtres(q: TrashListQuery): { where: string; values: SqlParam[] } {
    const clauses: string[] = [];
    const values: SqlParam[] = [];
    if (q.domain?.trim()) {
      clauses.push('domain LIKE ?');
      values.push(`%${q.domain.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`);
    }
    if (q.gamme) {
      clauses.push('gamme = ?');
      values.push(q.gamme);
    }
    if (q.scope) {
      clauses.push('scope = ?');
      values.push(q.scope);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', values };
  }

  lister(q: TrashListQuery, limit: number, offset: number): Promise<TrashRow[]> {
    const { where, values } = this.filtres(q);
    return this.db.query<TrashRow>(
      `SELECT ${COLONNES} FROM scan_trash ${where} ORDER BY deleted_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
  }

  async compter(q: TrashListQuery): Promise<number> {
    const { where, values } = this.filtres(q);
    const ligne = await this.db.queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM scan_trash ${where}`,
      values,
    );
    return Number(ligne?.total ?? 0);
  }

  trouver(id: string): Promise<TrashRow | null> {
    return this.db.queryOne<TrashRow>(`SELECT ${COLONNES} FROM scan_trash WHERE id = ?`, [id]);
  }

  async instantaneCompresse(id: string): Promise<Buffer | null> {
    const ligne = await this.db.queryOne<RowDataPacket & { payload_gz: Buffer }>(
      'SELECT payload_gz FROM scan_trash WHERE id = ?',
      [id],
    );
    return ligne?.payload_gz ?? null;
  }

  async supprimer(id: string): Promise<boolean> {
    return (await this.db.execute('DELETE FROM scan_trash WHERE id = ?', [id])) > 0;
  }

  /** Efface les entrées échues — appelé par le travail de rétention. */
  purger(lot: number): Promise<number> {
    return this.db.execute(
      // `ORDER BY purge_after ASC` : les plus anciennement échues d'abord, sans
      // quoi un lot pourrait tourner sans jamais atteindre les plus vieilles.
      'DELETE FROM scan_trash WHERE purge_after < NOW() ORDER BY purge_after ASC LIMIT ?',
      [lot],
    );
  }

  /** Volumétrie de la corbeille, pour la supervision. */
  async volumetrie(): Promise<{ entrees: number; octets: number; echues: number }> {
    const ligne = await this.db.queryOne<
      RowDataPacket & { entrees: number; octets: number | null; echues: number }
    >(
      `SELECT COUNT(*)                                        AS entrees,
              SUM(payload_bytes)                              AS octets,
              SUM(purge_after < NOW())                        AS echues
         FROM scan_trash`,
    );
    return {
      entrees: Number(ligne?.entrees ?? 0),
      octets: Number(ligne?.octets ?? 0),
      echues: Number(ligne?.echues ?? 0),
    };
  }

  // ── Restauration ───────────────────────────────────────────────────────────

  /**
   * Réinsère un instantané, dans une transaction.
   *
   * Un site peut avoir été RESCANNÉ depuis sa suppression : son identité
   * (domaine + gamme) existe alors avec un autre identifiant technique. On
   * réutilise la ligne existante et on redirige les sessions vers elle — créer
   * un doublon violerait `uniq_identity`, et écraser la ligne récente
   * effacerait un scan que personne n'a demandé de supprimer.
   *
   * Une session déjà présente est IGNORÉE, jamais écrasée : le rescan est plus
   * récent que l'archive.
   */
  async restaurer(instantane: Instantane): Promise<Restauration> {
    return this.db.transaction(async conn => {
      const colonnes = await this.colonnesReelles(conn);
      const remplacement = new Map<string, string>();
      let sites = 0;

      for (const site of instantane.sites) {
        // `gamme` vient d'une colonne VARCHAR : elle est une chaîne ou `null`.
        // Le type de l'instantané est volontairement ouvert, d'où la réduction
        // explicite — une valeur inattendue produirait une clé d'identité qui
        // ne correspondrait à aucun site, jamais un `[object Object]`.
        const gamme = typeof site.gamme === 'string' ? site.gamme : '';
        const identite = `${String(site.domain)}|${gamme}`;
        const [existantes] = await conn.query<(RowDataPacket & { id: string })[]>(
          'SELECT id FROM sites WHERE identity_key = ?',
          [identite],
        );
        const existant = existantes[0];
        if (existant) {
          remplacement.set(String(site.id), existant.id);
          continue;
        }
        await this.inserer(conn, 'sites', site, colonnes.sites);
        sites += 1;
      }

      let sessions = 0;
      let skippedSessions = 0;
      const sessionsRestaurees = new Set<string>();

      for (const session of instantane.sessions) {
        const id = String(session.id);
        const [deja] = await conn.query<RowDataPacket[]>(
          'SELECT 1 FROM scan_sessions WHERE id = ?',
          [id],
        );
        if (deja.length > 0) {
          skippedSessions += 1;
          continue;
        }
        const siteId = String(session.site_id);
        await this.inserer(
          conn,
          'scan_sessions',
          { ...session, site_id: remplacement.get(siteId) ?? siteId },
          colonnes.sessions,
        );
        sessionsRestaurees.add(id);
        sessions += 1;
      }

      let pages = 0;
      for (const page of instantane.pages) {
        // Une page dont la session a été ignorée n'a nulle part où aller : la
        // réinsérer violerait la clé étrangère, et la rattacher à la session
        // rescannée mélangerait deux audits distincts.
        if (!sessionsRestaurees.has(String(page.session_id))) continue;
        await this.inserer(conn, 'scan_pages', page, colonnes.pages);
        pages += 1;
      }

      return { sites, sessions, pages, skippedSessions };
    });
  }

  /**
   * Colonnes réellement insérables de chaque table.
   *
   * Les colonnes GÉNÉRÉES sont exclues : MariaDB refuse qu'on leur affecte une
   * valeur, et `identity_key` en est une. Les clés de l'instantané sont filtrées
   * contre cette liste, ce qui rend la restauration tolérante à une colonne
   * retirée du schéma depuis l'archivage.
   */
  private async colonnesReelles(
    conn: PoolConnection,
  ): Promise<{ sites: Set<string>; sessions: Set<string>; pages: Set<string> }> {
    const [lignes] = await conn.query<(RowDataPacket & { t: string; c: string })[]>(
      // `IS NULL OR = ''` et non l'un des deux : MariaDB rend `NULL` pour une
      // colonne ordinaire, MySQL une chaîne vide. Ne tester qu'une forme vidait
      // la liste sur l'autre moteur — et une liste vide produit un `INSERT`
      // sans colonnes, donc « Field 'id' doesn't have a default value ». Le cas
      // est arrivé, et c'est le test d'intégration qui l'a dit.
      `SELECT table_name AS t, column_name AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name IN ('sites', 'scan_sessions', 'scan_pages')
          AND (generation_expression IS NULL OR generation_expression = '')`,
    );
    const par = (nom: string) => new Set(lignes.filter(l => l.t === nom).map(l => l.c));
    return {
      sites: par('sites'),
      sessions: par('scan_sessions'),
      pages: par('scan_pages'),
    };
  }

  private async inserer(
    conn: PoolConnection,
    table: 'sites' | 'scan_sessions' | 'scan_pages',
    ligne: LigneInstantanee,
    colonnes: Set<string>,
  ): Promise<void> {
    const cles = Object.keys(ligne).filter(cle => colonnes.has(cle));
    const marqueurs = cles.map(() => '?').join(', ');
    // Les noms de colonnes viennent d'`information_schema`, pas de l'appelant :
    // l'intersection ci-dessus est ce qui garantit qu'aucune clé arbitraire
    // n'atteint le texte de la requête.
    const liste = cles.map(cle => `\`${cle}\``).join(', ');
    await conn.query(`INSERT INTO ${table} (${liste}) VALUES (${marqueurs})`, [
      ...cles.map(cle => ligne[cle]),
    ]);
  }
}
