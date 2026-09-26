import { randomUUID } from 'node:crypto';
import type { ScanSearchQuery } from '@websentry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../src/database/database.service.js';
import { ScanRepository } from '../../src/database/repositories/scan.repository.js';
import { appliquerSchema, ouvrir, viderTables } from './base.js';

/**
 * L'historique des scans contre un vrai moteur.
 *
 * Deux constructions y étaient invérifiables par un double : la fonction fenêtre
 * qui joint chaque site à sa DERNIÈRE session, et la recherche plein texte en
 * mode booléen. Un double rend ce qu'on lui a dit de rendre ; il ne dira jamais
 * que `ROW_NUMBER()` a partitionné autrement qu'on l'imaginait, ni qu'un mot de
 * deux lettres n'est pas indexé.
 */

/** Une requête de recherche complète — les valeurs par défaut du schéma. */
const requete = (over: Partial<ScanSearchQuery> = {}): ScanSearchQuery => ({
  page: 1,
  limit: 20,
  sort: 'analyzedAt',
  order: 'desc',
  ...over,
});

describe('ScanRepository sur MariaDB', () => {
  let db: DatabaseService;
  let repo: ScanRepository;

  beforeAll(async () => {
    db = await ouvrir();
    await appliquerSchema(db);
    repo = new ScanRepository(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await viderTables(db);
  });

  async function site(domain: string, gamme: string | null, epj: string | null): Promise<string> {
    const id = randomUUID();
    await db.execute(
      `INSERT INTO sites (id, domain, gamme, epj, first_seen, last_seen)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [id, domain, gamme, epj],
    );
    return id;
  }

  async function session(siteId: string, analyzedAt: string, score: number): Promise<string> {
    const id = randomUUID();
    await db.execute(
      `INSERT INTO scan_sessions (id, site_id, page_count, avg_score, min_score, max_score, analyzed_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [id, siteId, score, score, score, analyzedAt],
    );
    return id;
  }

  describe('ROW_NUMBER() OVER (PARTITION BY …)', () => {
    it('joint chaque site à sa DERNIÈRE session, et à elle seule', async () => {
      const a = await site('alpha.test', 'premium', 'EPJ-1');
      const b = await site('beta.test', 'standard', 'EPJ-2');
      await session(a, '2026-01-01 10:00:00', 2);
      const derniereA = await session(a, '2026-03-01 10:00:00', 4);
      await session(b, '2026-02-01 10:00:00', 3);
      const derniereB = await session(b, '2026-02-15 10:00:00', 5);

      const lignes = await repo.listSites(requete(), 20, 0);

      // Une ligne par site : si la partition ne prenait pas, chaque session
      // produirait sa propre ligne et le même site apparaîtrait deux fois.
      expect(lignes).toHaveLength(2);
      const parDomaine = new Map(lignes.map(l => [l.domain, l]));
      expect(parDomaine.get('alpha.test')?.last_session_id).toBe(derniereA);
      expect(parDomaine.get('beta.test')?.last_session_id).toBe(derniereB);
      expect(Number(parDomaine.get('alpha.test')?.session_count)).toBe(2);
    });

    it('DÉPARTAGE deux sessions de même horodatage par leur identifiant', async () => {
      // L'ordre de la fenêtre porte sur `analyzed_at DESC, id DESC` : sans le
      // second critère, deux scans lancés dans la même seconde donneraient une
      // ligne différente d'une requête à l'autre.
      const a = await site('ex-aequo.test', null, null);
      const ids = ['1111', '2222'].map(p => `${p}1111-1111-4111-8111-111111111111`);
      for (const id of ids) {
        await db.execute(
          `INSERT INTO scan_sessions (id, site_id, page_count, avg_score, analyzed_at)
           VALUES (?, ?, 1, 3, '2026-04-01 12:00:00')`,
          [id, a],
        );
      }

      const premier = await repo.listSites(requete(), 20, 0);
      const second = await repo.listSites(requete(), 20, 0);

      expect(premier[0]?.last_session_id).toBe(ids[1]);
      expect(second[0]?.last_session_id).toBe(ids[1]);
    });

    it('GARDE visible un site dont toutes les sessions ont disparu', async () => {
      // C'est l'intention du LEFT JOIN : un site invisible serait aussi
      // indestructible depuis l'interface.
      await site('orphelin.test', 'premium', null);

      const lignes = await repo.listSites(requete(), 20, 0);

      expect(lignes).toHaveLength(1);
      expect(lignes[0]?.last_session_id).toBeNull();
      expect(lignes[0]?.last_scan).not.toBeNull();
    });
  });

  describe('MATCH … AGAINST en mode booléen', () => {
    beforeEach(async () => {
      const a = await site('boulangerie-durand.fr', 'premium', 'EPJ-4242');
      await session(a, '2026-01-10 10:00:00', 4);
      const b = await site('patisserie-martin.fr', 'standard', 'EPJ-7777');
      await session(b, '2026-01-11 10:00:00', 3);
    });

    it('trouve un site par un DÉBUT de mot', async () => {
      // La troncature à droite est ce que le mode booléen sait faire ; c'est
      // aussi ce que la v1 croyait faire à gauche.
      const lignes = await repo.listSites(requete({ q: 'boulang' }), 20, 0);

      expect(lignes.map(l => l.domain)).toEqual(['boulangerie-durand.fr']);
    });

    it('trouve un site par son EPJ, indexé avec le domaine', async () => {
      const lignes = await repo.listSites(requete({ q: '7777' }), 20, 0);

      expect(lignes.map(l => l.domain)).toEqual(['patisserie-martin.fr']);
    });

    it('NE CASSE PAS sur un terme fait d’opérateurs', async () => {
      // `+ - ( ) ~ *` sont des opérateurs en mode booléen : la v1 les passait
      // bruts et servait une erreur de syntaxe SQL en 500.
      await expect(repo.listSites(requete({ q: '+++ ((( ~~~' }), 20, 0)).resolves.toEqual([]);
    });

    it('RETOMBE sur un LIKE quand le terme est trop court pour l’index', async () => {
      // MariaDB n'indexe pas les mots de moins de trois caractères. Refuser la
      // recherche laisserait croire qu'aucun site ne correspond.
      const lignes = await repo.listSites(requete({ q: 'fr' }), 20, 0);

      expect(lignes.map(l => l.domain).sort()).toEqual([
        'boulangerie-durand.fr',
        'patisserie-martin.fr',
      ]);
    });

    it('compte les mêmes lignes que la liste', async () => {
      // `countSites` et `listSites` partagent les filtres mais pas la requête :
      // une divergence donnerait une pagination qui annonce des pages vides.
      const total = await repo.countSites(requete({ q: 'boulang' }));
      const lignes = await repo.listSites(requete({ q: 'boulang' }), 20, 0);

      expect(total).toBe(lignes.length);
    });
  });
});
