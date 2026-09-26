import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { ScanTrashRepository } from './scan-trash.repository.js';

/** Colonnes qu'`information_schema` rendrait pour les trois tables. */
const COLONNES = [
  { t: 'sites', c: 'id' },
  { t: 'sites', c: 'domain' },
  { t: 'sites', c: 'gamme' },
  { t: 'scan_sessions', c: 'id' },
  { t: 'scan_sessions', c: 'site_id' },
  { t: 'scan_pages', c: 'id' },
  { t: 'scan_pages', c: 'session_id' },
];

function build(enabled = true) {
  const conn = {
    query: vi.fn().mockResolvedValue([[]]),
  };
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(0),
    transaction: vi.fn().mockImplementation((fn: (c: typeof conn) => unknown) => fn(conn)),
  };
  return { repo: new ScanTrashRepository(db as unknown as DatabaseService), db, conn };
}

/** Tout le SQL émis, espaces normalisés. */
function sqlDe(appels: { mock: { calls: unknown[][] } }): string {
  return appels.mock.calls
    .map(appel => String(appel[0]))
    .join(' ')
    .replace(/\s+/g, ' ');
}

const ENTREE = {
  id: 'e1',
  scope: 'site' as const,
  domain: 'exemple.fr',
  gamme: 'premium',
  label: 'exemple.fr — premium',
  sessionCount: 1,
  pageCount: 2,
  payloadGz: Buffer.from([0x1f, 0x8b]),
  payloadBytes: 1024,
  deletedBy: null,
  deletedByName: 'alice',
  purgeAfterDays: 30,
};

describe('ScanTrashRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('suit la disponibilité de la base', () => {
    expect(t.repo.available).toBe(true);
    expect(build(false).repo.available).toBe(false);
  });

  describe('capture', () => {
    it('lit les trois tables par leurs identifiants', async () => {
      await t.repo.capturer(['s1'], ['se1']);

      const sql = sqlDe(t.db.query);
      expect(sql).toContain('SELECT * FROM sites WHERE id IN (?)');
      expect(sql).toContain('SELECT * FROM scan_sessions WHERE id IN (?)');
      expect(sql).toContain('SELECT * FROM scan_pages WHERE session_id IN (?)');
    });

    it('n’émet AUCUNE requête pour une liste vide', async () => {
      // `IN ()` est une erreur de syntaxe : l'appel doit être évité, pas tenté.
      await expect(t.repo.capturer([], [])).resolves.toEqual({
        sites: [],
        sessions: [],
        pages: [],
      });
      expect(t.db.query).not.toHaveBeenCalled();
    });

    it('dérive les marqueurs de la LONGUEUR du tableau, jamais de son contenu', async () => {
      await t.repo.capturer(['a', 'b', 'c'], []);

      expect(sqlDe(t.db.query)).toContain('IN (?, ?, ?)');
      expect(t.db.query.mock.calls[0]?.[1]).toEqual(['a', 'b', 'c']);
    });

    it('ne laisse RIEN d’une valeur hostile entrer dans le texte de la requête', async () => {
      // La valeur reste liée : c'est ce qui rend l'injection structurellement
      // impossible ici.
      await t.repo.capturer(["' OR 1=1 --"], []);

      expect(sqlDe(t.db.query)).not.toContain('OR 1=1');
      expect(t.db.query.mock.calls[0]?.[1]).toEqual(["' OR 1=1 --"]);
    });
  });

  describe('résolution des cibles', () => {
    it('trouve un site par sa clé d’identité', async () => {
      t.db.queryOne.mockResolvedValue({ id: 's1' });

      await expect(t.repo.siteParIdentite('exemple.fr', 'premium')).resolves.toBe('s1');
      expect(t.db.queryOne.mock.calls[0]?.[1]).toEqual(['exemple.fr|premium']);
    });

    it('compose la clé d’un site SANS gamme avec un suffixe vide', async () => {
      // `domaine|` : c'est la forme que la colonne générée produit, et deux
      // formes divergentes ne se retrouveraient jamais.
      await t.repo.siteParIdentite('exemple.fr', null);

      expect(t.db.queryOne.mock.calls[0]?.[1]).toEqual(['exemple.fr|']);
    });

    it('rend null quand le site n’existe pas', async () => {
      await expect(t.repo.siteParIdentite('absent.fr', null)).resolves.toBeNull();
    });

    it('liste les sites d’un domaine, toutes gammes', async () => {
      t.db.query.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

      await expect(t.repo.sitesDuDomaine('exemple.fr')).resolves.toEqual(['s1', 's2']);
    });

    it('n’interroge PAS les sessions d’une liste de sites vide', async () => {
      await expect(t.repo.sessionsDesSites([])).resolves.toEqual([]);
      expect(t.db.query).not.toHaveBeenCalled();
    });
  });

  describe('écriture', () => {
    it('calcule l’échéance en SQL, depuis le nombre de jours', async () => {
      // Calculée par la base et non par le processus : deux horloges qui
      // divergent produiraient des échéances incohérentes entre elles.
      await t.repo.ajouter(ENTREE);

      const sql = sqlDe(t.db.execute);
      expect(sql).toContain('DATE_ADD(NOW(), INTERVAL ? DAY)');
      expect(t.db.execute.mock.calls[0]?.[1]).toContain(30);
    });

    it('écrit l’instantané en BINAIRE, pas en texte', async () => {
      await t.repo.ajouter(ENTREE);

      const params = t.db.execute.mock.calls[0]?.[1] as unknown[];
      expect(params.some(p => Buffer.isBuffer(p))).toBe(true);
    });
  });

  describe('filtres de liste', () => {
    it('n’ajoute AUCUNE clause sans filtre', async () => {
      await t.repo.lister({ page: 1, limit: 25 }, 25, 0);

      expect(sqlDe(t.db.query)).not.toContain('WHERE');
    });

    it('filtre par domaine, gamme et portée', async () => {
      await t.repo.lister(
        { page: 1, limit: 25, domain: 'ex', gamme: 'premium', scope: 'domain' },
        25,
        0,
      );

      const sql = sqlDe(t.db.query);
      expect(sql).toContain('domain LIKE ?');
      expect(sql).toContain('gamme = ?');
      expect(sql).toContain('scope = ?');
    });

    it('NEUTRALISE les jokers d’un motif de recherche', async () => {
      // Un `%` saisi tel quel balaierait toute la table : on le traite comme le
      // caractère que l'utilisateur a voulu écrire.
      await t.repo.lister({ page: 1, limit: 25, domain: '100%_test' }, 25, 0);

      expect(t.db.query.mock.calls[0]?.[1]?.[0]).toBe('%100\\%\\_test%');
    });

    it('trie du plus récent au plus ancien, avec un départage stable', async () => {
      await t.repo.lister({ page: 1, limit: 25 }, 25, 0);

      expect(sqlDe(t.db.query)).toContain('ORDER BY deleted_at DESC, id ASC');
    });

    it('compte avec les MÊMES filtres que la liste', async () => {
      // Deux jeux de filtres divergents donneraient une pagination annonçant
      // des pages vides.
      await t.repo.compter({ page: 1, limit: 25, scope: 'session' });

      expect(sqlDe(t.db.queryOne)).toContain('scope = ?');
    });
  });

  describe('purge', () => {
    it('efface les plus anciennement échues d’abord, par lots', async () => {
      await t.repo.purger(100);

      const sql = sqlDe(t.db.execute);
      expect(sql).toContain('purge_after < NOW()');
      expect(sql).toContain('ORDER BY purge_after ASC');
      expect(sql).toContain('LIMIT ?');
    });

    it('rend le nombre de lignes effacées', async () => {
      t.db.execute.mockResolvedValue(7);

      await expect(t.repo.purger(100)).resolves.toBe(7);
    });

    it('dit si la suppression d’une entrée a porté', async () => {
      t.db.execute.mockResolvedValue(1);
      await expect(t.repo.supprimer('e1')).resolves.toBe(true);

      t.db.execute.mockResolvedValue(0);
      await expect(t.repo.supprimer('e1')).resolves.toBe(false);
    });
  });

  describe('volumétrie', () => {
    it('convertit une somme absente en zéro', async () => {
      // `SUM` rend NULL sur une table vide : la supervision afficherait
      // « null » au premier jour d'une installation.
      t.db.queryOne.mockResolvedValue({ entrees: 0, octets: null, echues: 0 });

      await expect(t.repo.volumetrie()).resolves.toEqual({ entrees: 0, octets: 0, echues: 0 });
    });
  });

  describe('restauration', () => {
    beforeEach(() => {
      t.conn.query.mockImplementation((sql: string) => {
        if (sql.includes('information_schema')) return Promise.resolve([COLONNES]);
        // Aucun site ni session préexistants.
        return Promise.resolve([[]]);
      });
    });

    it('tourne dans une TRANSACTION', async () => {
      // Une restauration à moitié faite laisserait des sessions sans site.
      await t.repo.restaurer({ sites: [], sessions: [], pages: [] });

      expect(t.db.transaction).toHaveBeenCalled();
    });

    it('EXCLUT les colonnes que le schéma ne connaît pas', async () => {
      // Une colonne retirée du schéma depuis l'archivage ne doit pas faire
      // échouer la restauration entière.
      await t.repo.restaurer({
        sites: [{ id: 's1', domain: 'exemple.fr', gamme: null, colonne_disparue: 'x' }],
        sessions: [],
        pages: [],
      });

      const insert = t.conn.query.mock.calls
        .map(c => String(c[0]))
        .find(s => s.includes('INSERT INTO sites'));
      expect(insert).toContain('`id`');
      expect(insert).toContain('`domain`');
      expect(insert).not.toContain('colonne_disparue');
    });

    it('RATTACHE les pages à leur session, et ignore les orphelines', async () => {
      const bilan = await t.repo.restaurer({
        sites: [],
        sessions: [{ id: 'se1', site_id: 's1' }],
        pages: [
          { id: 'p1', session_id: 'se1' },
          { id: 'p2', session_id: 'se-absente' },
        ],
      });

      expect(bilan.sessions).toBe(1);
      expect(bilan.pages).toBe(1);
    });
  });
});
