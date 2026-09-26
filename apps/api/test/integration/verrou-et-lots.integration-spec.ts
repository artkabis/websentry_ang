import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../src/database/database.service.js';
import { ProfileRepository } from '../../src/database/repositories/profile.repository.js';
import { UsageRepository } from '../../src/database/repositories/usage.repository.js';
import { appliquerSchema, compte, ouvrir, viderTables } from './base.js';

/**
 * Deux garanties que seule une vraie base peut établir.
 *
 * Le verrouillage optimiste repose sur l'ATOMICITÉ d'un `UPDATE … WHERE
 * version = ?` : un double ne peut pas prouver qu'aucune fenêtre ne s'ouvre
 * entre la comparaison et l'incrément, puisqu'il n'a ni verrou de ligne ni
 * concurrence réelle. L'anonymisation repose sur un `UPDATE … ORDER BY …
 * LIMIT` : le nombre de lignes touchées était vérifié, jamais LESQUELLES.
 */
describe('verrouillage optimiste et traitement par lots', () => {
  let db: DatabaseService;
  let profils: ProfileRepository;
  let usage: UsageRepository;

  beforeAll(async () => {
    db = await ouvrir();
    await appliquerSchema(db);
    profils = new ProfileRepository(db);
    usage = new UsageRepository(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await viderTables(db);
  });

  describe('UPDATE … WHERE version = ?', () => {
    beforeEach(async () => {
      await profils.create('premium', 'Premium', null, { seuil: 4 }, null);
    });

    it('incrémente la version quand elle correspond', async () => {
      const ok = await profils.updateWithVersion(
        'premium',
        'Premium v2',
        null,
        { seuil: 5 },
        null,
        1,
      );

      expect(ok).toBe(true);
      expect(await profils.currentVersion('premium')).toBe(2);
    });

    it('REFUSE une écriture fondée sur une version dépassée', async () => {
      await profils.updateWithVersion('premium', 'Premium v2', null, { seuil: 5 }, null, 1);

      const tardif = await profils.updateWithVersion(
        'premium',
        'Écrasé par erreur',
        null,
        { seuil: 0 },
        null,
        1,
      );

      expect(tardif).toBe(false);
      // Et rien n'a bougé : un refus qui laisserait une écriture partielle
      // serait pire qu'une absence de verrou.
      const ligne = await profils.findByGamme('premium');
      expect(ligne?.label).toBe('Premium v2');
      expect(ligne?.version).toBe(2);
    });

    it('LAISSE PASSER UNE SEULE de deux écritures concurrentes', async () => {
      // Le cœur du verrou : deux clients ont lu la version 1 et écrivent en
      // même temps, sur deux connexions du pool. InnoDB sérialise sur la ligne ;
      // le second voit alors version = 2 et sa condition ne matche plus.
      const [a, b] = await Promise.all([
        profils.updateWithVersion('premium', 'Client A', null, { seuil: 5 }, null, 1),
        profils.updateWithVersion('premium', 'Client B', null, { seuil: 1 }, null, 1),
      ]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await profils.currentVersion('premium')).toBe(2);
      const ligne = await profils.findByGamme('premium');
      expect(['Client A', 'Client B']).toContain(ligne?.label);
    });

    it('ÉCRASE sans condition quand la version attendue est nulle', async () => {
      // L'import délibéré : l'appelant sait qu'il écrase, et le dit en passant
      // `null`. Sans cette porte, un import de profils v1 serait impossible.
      const ok = await profils.updateWithVersion(
        'premium',
        'Importé',
        null,
        { seuil: 3 },
        null,
        null,
      );

      expect(ok).toBe(true);
      expect(await profils.currentVersion('premium')).toBe(2);
    });

    it('ne crée rien quand la gamme n’existe pas', async () => {
      const ok = await profils.updateWithVersion('inconnue', 'X', null, {}, null, 1);

      expect(ok).toBe(false);
    });
  });

  describe('UPDATE … ORDER BY … LIMIT', () => {
    /** Cinq entrées de journal, de la plus ancienne à la plus récente. */
    async function journal(): Promise<string[]> {
      const acteur = await compte(db, randomUUID(), { username: 'tracee' });
      const jours = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
      for (const jour of jours) {
        await db.execute(
          `INSERT INTO audit_log (actor_id, actor_name, action, ip_address, created_at)
           VALUES (?, 'tracee', 'user.login', '203.0.113.7', ?)`,
          [acteur, `${jour} 08:00:00`],
        );
      }
      return jours;
    }

    it('anonymise les lignes LES PLUS ANCIENNES d’abord', async () => {
      // C'est ce que le double ne pouvait pas dire : il comptait les lignes
      // touchées, sans jamais vérifier que `ORDER BY created_at ASC` choisit
      // bien les plus vieilles. Sans cet ordre, un passage par lots pourrait
      // tourner indéfiniment sans jamais atteindre les plus anciennes.
      await journal();

      const touchees = await usage.anonymiser('2026-02-01 00:00:00', 2);

      expect(touchees).toBe(2);
      const restantes = await db.query<RowDataPacket & { created_at: string }>(
        'SELECT created_at FROM audit_log WHERE actor_id IS NOT NULL ORDER BY created_at ASC',
      );
      expect(restantes.map(r => r.created_at.slice(0, 10))).toEqual([
        '2026-01-03',
        '2026-01-04',
        '2026-01-05',
      ]);
    });

    it('efface les TROIS champs identifiants, et rien d’autre', async () => {
      await journal();

      await usage.anonymiser('2026-02-01 00:00:00', 1);

      const ligne = await db.queryOne<
        RowDataPacket & {
          actor_id: string | null;
          actor_name: string | null;
          ip_address: string | null;
          action: string;
        }
      >('SELECT actor_id, actor_name, ip_address, action FROM audit_log ORDER BY created_at ASC');

      expect(ligne?.actor_id).toBeNull();
      expect(ligne?.actor_name).toBeNull();
      expect(ligne?.ip_address).toBeNull();
      // L'action reste : c'est elle qui donne sa valeur au journal une fois
      // l'identité retirée.
      expect(ligne?.action).toBe('user.login');
    });

    it('N’ANONYMISE PAS deux fois la même ligne', async () => {
      // Le filtre `actor_id IS NOT NULL OR …` est ce qui fait converger le
      // passage par lots : sans lui, chaque lot réécrirait les mêmes lignes.
      await journal();

      await usage.anonymiser('2026-02-01 00:00:00', 5);
      const second = await usage.anonymiser('2026-02-01 00:00:00', 5);

      expect(second).toBe(0);
      expect(await usage.lignesEnAttente('2026-02-01 00:00:00')).toBe(0);
      expect(await usage.lignesAnonymisees()).toBe(5);
    });

    it('RESPECTE la borne de date', async () => {
      await journal();

      const touchees = await usage.anonymiser('2026-01-03 00:00:00', 10);

      expect(touchees).toBe(2);
      expect(await usage.lignesEnAttente('2026-01-03 00:00:00')).toBe(0);
    });
  });
});
