import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { FeedbackRepository } from './feedback.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
  };
  return { repo: new FeedbackRepository(db as unknown as DatabaseService), db };
}

/** Clause WHERE isolée, espaces normalisés. */
function whereDe(sql: string): string {
  return (/WHERE .*?(?= ORDER BY| GROUP BY|$)/s.exec(sql)?.[0] ?? '').replace(/\s+/g, ' ').trim();
}

describe('FeedbackRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('lecture', () => {
    it('n’ajoute aucune clause WHERE sans filtre', async () => {
      await t.repo.list({}, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([25, 0]);
    });

    it('rend le plus récent d’abord, départagé par identifiant', async () => {
      // Deux retours déposés à la même seconde doivent garder un ordre stable,
      // sans quoi la pagination peut en sauter ou en répéter.
      await t.repo.list({}, 25, 0);
      expect((t.db.query.mock.calls[0] as [string])[0]).toContain(
        'ORDER BY f.created_at DESC, f.id DESC',
      );
    });

    it('ramène le nom de l’assigné par jointure GAUCHE', async () => {
      // Un compte supprimé met la clé à NULL : une jointure interne ferait
      // disparaître le retour au lieu de le montrer sans assigné.
      await t.repo.list({}, 25, 0);
      const [sql] = t.db.query.mock.calls[0] as [string];

      expect(sql).toContain('LEFT JOIN users a ON a.id = f.assigned_to');
      expect(sql).toContain('a.username AS assigned_name');
    });

    it('PARAMÈTRE la recherche, jokers compris', async () => {
      await t.repo.list({ search: "score' OR 1=1 --" }, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('(f.title LIKE ? OR f.body LIKE ?)');
      expect(sql).not.toContain('%');
      expect(params.slice(0, 2)).toEqual(Array(2).fill("%score' OR 1=1 --%"));
    });

    it('combine les filtres par ET, dans l’ordre des paramètres', async () => {
      await t.repo.list({ status: 'nouveau', kind: 'bug', severity: 'majeur' }, 10, 20);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('WHERE f.status = ? AND f.kind = ? AND f.severity = ?');
      expect(params).toEqual(['nouveau', 'bug', 'majeur', 10, 20]);
    });

    it('filtre par auteur — le garde-fou de visibilité passe par le SQL', async () => {
      await t.repo.list({ authorId: 'u-1' }, 25, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('f.author_id = ?');
      expect(params[0]).toBe('u-1');
    });

    it('applique au COMPTAGE exactement le même filtre qu’à la lecture', async () => {
      const filtres = { status: 'nouveau', authorId: 'u-1', search: 'score' };
      await t.repo.list(filtres, 25, 0);
      await t.repo.count(filtres);

      const [sqlListe, paramsListe] = t.db.query.mock.calls[0] as [string, unknown[]];
      const [sqlTotal, paramsTotal] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      expect(whereDe(sqlTotal)).toBe(whereDe(sqlListe));
      expect(paramsListe).toEqual([...paramsTotal, 25, 0]);
    });

    it('applique aux COMPTEURS PAR STATUT le même filtre', async () => {
      await t.repo.list({ authorId: 'u-1' }, 25, 0);
      await t.repo.countByStatus({ authorId: 'u-1' });

      const [sqlListe] = t.db.query.mock.calls[0] as [string];
      const [sqlCompteurs] = t.db.query.mock.calls[1] as [string];
      expect(whereDe(sqlCompteurs)).toBe(whereDe(sqlListe));
      expect(sqlCompteurs).toContain('GROUP BY f.status');
    });

    it('rend 0 quand le comptage ne ramène rien', async () => {
      expect(await t.repo.count({})).toBe(0);
    });

    it('rend le total quand la ligne existe', async () => {
      t.db.queryOne.mockResolvedValue({ total: 42 });
      expect(await t.repo.count({})).toBe(42);
    });

    it('charge un retour par identifiant paramétré', async () => {
      await t.repo.findById("u-1' OR '1'='1");
      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('WHERE f.id = ?');
      expect(params).toEqual(["u-1' OR '1'='1"]);
    });
  });

  describe('dépôt', () => {
    it('insère un retour NEUF, quel que soit l’appelant', async () => {
      await t.repo.create({
        id: 'f-1',
        kind: 'bug',
        severity: 'majeur',
        title: 'Titre',
        body: 'Corps du retour.',
        context: { route: '/analyse' },
        authorId: 'u-1',
        authorName: 'bob',
      });

      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("'nouveau'");
      expect(params).toEqual([
        'f-1',
        'bug',
        'majeur',
        'Titre',
        'Corps du retour.',
        '{"route":"/analyse"}',
        'u-1',
        'bob',
      ]);
    });

    it('écrit un contexte absent à NULL, pas à « null » en texte', async () => {
      await t.repo.create({
        id: 'f-1',
        kind: 'bug',
        severity: 'majeur',
        title: 'Titre',
        body: 'Corps du retour.',
        context: null,
        authorId: null,
        authorName: null,
      });

      expect((t.db.execute.mock.calls[0] as [string, unknown[]])[1][5]).toBeNull();
    });
  });

  describe('triage', () => {
    it('n’écrit QUE les champs fournis', async () => {
      await t.repo.triage('f-1', { severity: 'bloquant' });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('severity = ?');
      expect(sql).not.toContain('status');
      expect(sql).not.toContain('resolution');
      expect(params).toEqual(['bloquant', 'f-1']);
    });

    it('DISTINGUE un champ absent d’un champ mis à null', async () => {
      await t.repo.triage('f-1', { assigned_to: null, resolution: undefined });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('assigned_to = ?');
      expect(sql).not.toContain('resolution');
      expect(params).toEqual([null, 'f-1']);
    });

    it('DÉRIVE resolved_at du statut, en SQL', async () => {
      // Deux écritures séparées pourraient diverger si la seconde échouait ;
      // et laisser l'appelant poser la date permettrait d'horodater une
      // résolution qui n'a pas eu lieu.
      await t.repo.triage('f-1', { status: 'resolu' });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain("resolved_at = CASE WHEN ? = 'resolu' THEN NOW() ELSE NULL END");
      expect(params).toEqual(['resolu', 'resolu', 'f-1']);
    });

    it('EFFACE resolved_at quand le retour est rouvert', async () => {
      await t.repo.triage('f-1', { status: 'en_cours' });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('ELSE NULL END');
      expect(params).toEqual(['en_cours', 'en_cours', 'f-1']);
    });

    it('ne touche PAS resolved_at quand le statut ne change pas', async () => {
      await t.repo.triage('f-1', { severity: 'mineur' });
      expect((t.db.execute.mock.calls[0] as [string])[0]).not.toContain('resolved_at');
    });

    it('ne touche PAS la base quand rien n’est fourni', async () => {
      expect(await t.repo.triage('f-1', {})).toBe(0);
      expect(t.db.execute).not.toHaveBeenCalled();
    });

    it('ne touche PAS la base quand tous les champs sont indéfinis', async () => {
      expect(await t.repo.triage('f-1', { status: undefined, severity: undefined })).toBe(0);
      expect(t.db.execute).not.toHaveBeenCalled();
    });
  });

  describe('colonnes exposées', () => {
    it('ne lit PAS avec une étoile — les colonnes sont explicites', async () => {
      // Une colonne ajoutée plus tard au schéma ne doit pas se retrouver
      // automatiquement exposée par la route de lecture.
      await t.repo.list({}, 25, 0);
      await t.repo.findById('f-1');

      expect((t.db.query.mock.calls[0] as [string])[0]).not.toContain('SELECT *');
      expect((t.db.queryOne.mock.calls[0] as [string])[0]).not.toContain('SELECT *');
    });
  });
});
