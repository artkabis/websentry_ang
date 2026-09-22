import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database.service.js';
import { UserAdminRepository } from './user-admin.repository.js';

function build(enabled = true) {
  const db = {
    enabled,
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(1),
  };
  return { repo: new UserAdminRepository(db as unknown as DatabaseService), db };
}

/** Clause SELECT isolée — le reste du SQL nomme des colonnes homonymes. */
function selectDe(sql: string): string {
  return sql.slice(0, sql.indexOf('FROM'));
}

describe('UserAdminRepository', () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it('reflète la disponibilité de la base', () => {
    expect(build(false).repo.available).toBe(false);
  });

  describe('colonnes exposées', () => {
    it('ne rapatrie NI l’empreinte NI les compteurs d’échec', async () => {
      // Ce qui n'est pas lu ne peut pas fuir : la barrière la plus sûre est en
      // amont du DTO, dans la requête elle-même.
      await t.repo.list({}, 50, 0);
      await t.repo.findById('u-1');

      for (const appel of [
        t.db.query.mock.calls[0] as [string],
        t.db.queryOne.mock.calls[0] as [string],
      ]) {
        const select = selectDe(appel[0]);
        expect(select).not.toContain('password_hash');
        expect(select).not.toContain('token_version');
        expect(select).not.toContain('failed_logins');
        expect(select).toContain('username');
      }
    });
  });

  describe('list / count', () => {
    it('n’ajoute aucune clause WHERE sans filtre', async () => {
      await t.repo.list({}, 50, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([50, 0]);
    });

    it('trie par rang décroissant puis par identifiant', async () => {
      await t.repo.list({}, 50, 0);
      const [sql] = t.db.query.mock.calls[0] as [string];
      expect(sql).toContain('ORDER BY rank DESC, username ASC');
    });

    it('PARAMÈTRE la recherche, jokers compris', async () => {
      // Concaténer les « % » dans le texte SQL rouvrirait l'injection que le
      // « ? » ferme : ils doivent voyager comme valeur.
      await t.repo.list({ search: "bob' OR 1=1 --" }, 50, 0);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('(username LIKE ? OR display_name LIKE ? OR email LIKE ?)');
      expect(sql).not.toContain('%');
      expect(params.slice(0, 3)).toEqual(Array(3).fill("%bob' OR 1=1 --%"));
    });

    it('combine les filtres par ET, dans l’ordre des paramètres', async () => {
      await t.repo.list({ rank: 50, status: 'suspended' }, 10, 20);
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE rank = ? AND status = ?');
      expect(params).toEqual([50, 'suspended', 10, 20]);
    });

    it('applique au COMPTAGE exactement le même filtre qu’à la liste', async () => {
      // Deux constructions séparées finiraient par diverger, et le total
      // annoncé ne correspondrait plus aux lignes affichées.
      const filtres = { search: 'ali', rank: 50, status: 'active' };
      await t.repo.list(filtres, 50, 0);
      await t.repo.count(filtres);

      const [sqlListe, paramsListe] = t.db.query.mock.calls[0] as [string, unknown[]];
      const [sqlTotal, paramsTotal] = t.db.queryOne.mock.calls[0] as [string, unknown[]];

      /** Clause WHERE isolée, espaces normalisés. */
      const whereDe = (sql: string) =>
        (/WHERE .*?(?= ORDER BY|$)/s.exec(sql)?.[0] ?? '').replace(/\s+/g, ' ').trim();

      expect(whereDe(sqlTotal)).toBe(whereDe(sqlListe));
      // La liste ajoute la pagination en queue : le reste doit coïncider.
      expect(paramsListe).toEqual([...paramsTotal, 50, 0]);
    });

    it('rend 0 quand le comptage ne ramène rien', async () => {
      expect(await t.repo.count({})).toBe(0);
    });

    it('rend le total quand la ligne existe', async () => {
      t.db.queryOne.mockResolvedValue({ total: 7 });
      expect(await t.repo.count({})).toBe(7);
    });
  });

  describe('countActiveAtLeastRank', () => {
    it('ne compte que les comptes ACTIFS au moins au rang demandé', async () => {
      t.db.queryOne.mockResolvedValue({ total: 2 });
      expect(await t.repo.countActiveAtLeastRank(50)).toBe(2);

      const [sql, params] = t.db.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("rank >= ? AND status = 'active'");
      expect(params).toEqual([50]);
    });

    it('rend 0 en l’absence de ligne', async () => {
      expect(await t.repo.countActiveAtLeastRank(50)).toBe(0);
    });
  });

  describe('create', () => {
    it('insère un compte ACTIF, avec son auteur', async () => {
      await t.repo.create({
        id: 'u-9',
        username: 'bob',
        passwordHash: 'sel:empreinte',
        rank: 10,
        displayName: null,
        email: null,
        createdBy: 'u-1',
      });

      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("'active'");
      expect(params).toEqual(['u-9', 'bob', 'sel:empreinte', 10, null, null, 'u-1']);
    });
  });

  describe('update', () => {
    it('n’écrit QUE les champs fournis', async () => {
      // Réécrire les champs absents avec `null` effacerait un courriel parce
      // qu'on a changé un rang.
      await t.repo.update('u-9', { rank: 30 });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('rank = ?');
      expect(sql).not.toContain('email');
      expect(sql).not.toContain('status');
      expect(params).toEqual([30, 'u-9']);
    });

    it('distingue un champ ABSENT d’un champ mis à null', async () => {
      await t.repo.update('u-9', { email: null, display_name: undefined });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('email = ?');
      expect(sql).not.toContain('display_name');
      expect(params).toEqual([null, 'u-9']);
    });

    it('rafraîchit updated_at à chaque écriture', async () => {
      await t.repo.update('u-9', { status: 'suspended' });
      const [sql] = t.db.execute.mock.calls[0] as [string];
      expect(sql).toContain('updated_at = NOW()');
    });

    it('ne touche PAS la base quand rien n’est fourni', async () => {
      expect(await t.repo.update('u-9', {})).toBe(0);
      expect(t.db.execute).not.toHaveBeenCalled();
    });

    it('ne touche PAS la base quand tous les champs sont indéfinis', async () => {
      expect(await t.repo.update('u-9', { rank: undefined, email: undefined })).toBe(0);
      expect(t.db.execute).not.toHaveBeenCalled();
    });
  });

  describe('updatePassword', () => {
    it('remet le verrou à zéro ET invalide les jetons émis', async () => {
      await t.repo.updatePassword('u-9', 'sel:nouvelle');
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('failed_logins = 0');
      expect(sql).toContain('locked_until = NULL');
      expect(sql).toContain('token_version = token_version + 1');
      expect(params).toEqual(['sel:nouvelle', 'u-9']);
    });
  });

  describe('delete', () => {
    it('supprime par identifiant paramétré', async () => {
      expect(await t.repo.delete('u-9')).toBe(1);
      expect(t.db.execute.mock.calls[0]).toEqual(['DELETE FROM users WHERE id = ?', ['u-9']]);
    });
  });

  describe('permissions', () => {
    it('liste les permissions, expirées comprises', async () => {
      // L'écran doit montrer une permission expirée : la masquer ferait croire
      // qu'elle n'a jamais été accordée.
      await t.repo.list_permissions('u-9');
      const [sql, params] = t.db.query.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain('FROM user_permissions WHERE user_id = ?');
      expect(sql).not.toContain('expires_at >');
      expect(sql).toContain('ORDER BY permission');
      expect(params).toEqual(['u-9']);
    });

    it('sérialise les gammes en JSON, et null quand la portée est totale', async () => {
      await t.repo.grantPermission({
        userId: 'u-9',
        permission: 'scan:run',
        gammes: ['sante'],
        grantedBy: 'u-1',
        expiresAt: null,
      });
      expect((t.db.execute.mock.calls[0] as [string, unknown[]])[1]).toEqual([
        'u-9',
        'scan:run',
        '["sante"]',
        'u-1',
        null,
      ]);

      await t.repo.grantPermission({
        userId: 'u-9',
        permission: 'scan:run',
        gammes: null,
        grantedBy: 'u-1',
        expiresAt: null,
      });
      expect((t.db.execute.mock.calls[1] as [string, unknown[]])[1][2]).toBeNull();
    });

    it('remplace un octroi existant plutôt que d’en empiler un second', async () => {
      await t.repo.grantPermission({
        userId: 'u-9',
        permission: 'scan:run',
        gammes: null,
        grantedBy: 'u-1',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      });
      const [sql, params] = t.db.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ON DUPLICATE KEY UPDATE');
      expect(params[4]).toBeInstanceOf(Date);
    });

    it('révoque une permission précise, et rend le nombre de lignes touchées', async () => {
      t.db.execute.mockResolvedValue(0);
      expect(await t.repo.revokePermission('u-9', 'scan:run')).toBe(0);
      expect(t.db.execute.mock.calls[0]).toEqual([
        'DELETE FROM user_permissions WHERE user_id = ? AND permission = ?',
        ['u-9', 'scan:run'],
      ]);
    });
  });
});
