import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionRepository } from '../../database/repositories/permission.repository.js';
import { SessionRepository } from '../../database/repositories/session.repository.js';
import { UserRepository } from '../../database/repositories/user.repository.js';
import type { DatabaseService } from '../../database/database.service.js';
import { LocalPermissionStore, LocalSessionStore, LocalUserStore } from './local-stores.js';
import { readAccounts, writeAccounts, type LocalAccountsFile } from './local-accounts.js';

/**
 * Base DÉSACTIVÉE : toute méthode qui tomberait sur celle du parent lèverait,
 * ce qui est exactement ce qu'on veut voir si une redéfinition manque.
 */
const baseIndisponible = {
  enabled: false,
  queryOne: () => Promise.reject(new Error('base non disponible')),
  execute: () => Promise.reject(new Error('base non disponible')),
  transaction: () => Promise.reject(new Error('base non disponible')),
} as unknown as DatabaseService;

const ID_ALICE = '11111111-1111-4111-8111-111111111111';

function fichier(over: Partial<LocalAccountsFile['accounts'][number]> = {}): LocalAccountsFile {
  return {
    version: 1,
    accounts: [
      {
        id: ID_ALICE,
        username: 'alice',
        passwordHash: 'aaaa:bbbb',
        rank: 50,
        status: 'active',
        tokenVersion: 3,
        failedLogins: 0,
        lockedUntil: null,
        ...over,
      },
    ],
  };
}

let chemin: string;

beforeEach(() => {
  chemin = join(mkdtempSync(join(tmpdir(), 'ws-comptes-')), 'comptes.json');
});

describe('redéfinition complète des dépôts', () => {
  // Les dépôts locaux héritent des dépôts SQL : une méthode oubliée tomberait
  // sur la base désactivée et lèverait à l'exécution, en production locale,
  // sur un chemin qu'aucun test n'emprunte forcément.
  it.each([
    ['UserRepository', UserRepository, LocalUserStore],
    ['SessionRepository', SessionRepository, LocalSessionStore],
    ['PermissionRepository', PermissionRepository, LocalPermissionStore],
  ])('%s — chaque méthode publique du parent est redéfinie', (_nom, Parent, Local) => {
    const heritees = Object.getOwnPropertyNames(Parent.prototype).filter(
      nom => nom !== 'constructor',
    );
    const redefinies = Object.getOwnPropertyNames(Local.prototype);

    // `generateRawToken` et `hashToken` sont de la cryptographie pure, sans
    // base : les hériter est voulu, et les redéfinir serait les dupliquer.
    const pures = ['generateRawToken', 'hashToken'];
    const manquantes = heritees.filter(nom => !redefinies.includes(nom) && !pures.includes(nom));

    expect(manquantes).toEqual([]);
  });
});

describe('LocalUserStore', () => {
  function store() {
    return new LocalUserStore(baseIndisponible, chemin);
  }

  it('se déclare disponible — c’est sa raison d’être', () => {
    expect(store().available).toBe(true);
  });

  it('trouve un compte par identifiant et par id', async () => {
    writeAccounts(chemin, fichier());

    expect((await store().findByUsername('alice'))?.rank).toBe(50);
    expect((await store().findById(ID_ALICE))?.username).toBe('alice');
  });

  it('rend null pour un compte inconnu', async () => {
    writeAccounts(chemin, fichier());

    expect(await store().findByUsername('bob')).toBeNull();
    expect(await store().findById(randomUUID())).toBeNull();
  });

  it('rend null quand aucun fichier n’existe', async () => {
    expect(await store().findByUsername('alice')).toBeNull();
  });

  it('VERROUILLE après des échecs, comme en base', async () => {
    // Un mode de développement qui relâcherait la défense contre la force
    // brute apprendrait à s'en passer — et la v1 ne la relâchait pas.
    writeAccounts(chemin, fichier());
    const verrou = new Date('2026-01-01T10:00:00.000Z');

    await store().recordFailedLogin(ID_ALICE, 5, verrou);

    const compte = readAccounts(chemin).accounts[0];
    expect(compte?.failedLogins).toBe(5);
    expect(compte?.lockedUntil).toBe(verrou.toISOString());
  });

  it('lève le verrou après une connexion réussie', async () => {
    writeAccounts(chemin, fichier({ failedLogins: 4, lockedUntil: '2026-01-01T10:00:00.000Z' }));

    await store().resetFailedLogins(ID_ALICE);

    expect(readAccounts(chemin).accounts[0]).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it('INCRÉMENTE token_version — la révocation vaut ici aussi', async () => {
    writeAccounts(chemin, fichier());

    await store().bumpTokenVersion(ID_ALICE);

    expect(readAccounts(chemin).accounts[0]?.tokenVersion).toBe(4);
  });

  it('RELIT le fichier à chaque accès', async () => {
    // La commande de création de compte s'utilise pendant que le serveur
    // tourne : une copie en mémoire serait périmée aussitôt.
    const depot = store();
    writeAccounts(chemin, fichier());
    expect((await depot.findByUsername('alice'))?.rank).toBe(50);

    writeAccounts(chemin, fichier({ rank: 100 }));

    expect((await depot.findByUsername('alice'))?.rank).toBe(100);
  });

  it('n’écrit rien pour un identifiant inconnu', async () => {
    // Une modification visant un compte absent ne doit pas en inventer un, ni
    // toucher à ceux qui existent.
    writeAccounts(chemin, fichier());

    await store().bumpTokenVersion(randomUUID());

    expect(readAccounts(chemin).accounts[0]?.tokenVersion).toBe(3);
  });

  it('EFFACE le verrou quand l’appelant ne pose pas de date', async () => {
    // Un échec qui n'atteint pas le seuil compte sans verrouiller.
    writeAccounts(chemin, fichier({ lockedUntil: '2026-01-01T10:00:00.000Z' }));

    await store().recordFailedLogin(ID_ALICE, 2, null);

    expect(readAccounts(chemin).accounts[0]).toMatchObject({ failedLogins: 2, lockedUntil: null });
  });

  it('REJETTE plutôt que de lever de façon synchrone', async () => {
    // Le contrat annonce une promesse : un appelant qui enchaîne un `.catch()`
    // verrait sinon l'erreur lui échapper.
    writeFileSync(chemin, '{ pas du json');

    await expect(store().findById(ID_ALICE)).rejects.toThrow();
  });

  it('REFUSE un fichier illisible au lieu de l’ignorer', async () => {
    // L'ignorer reviendrait à effacer en silence les comptes de quelqu'un
    // parce qu'une accolade manque.
    writeFileSync(chemin, '{ pas du json');

    await expect(store().findByUsername('alice')).rejects.toThrow();
  });
});

describe('LocalSessionStore', () => {
  function stores() {
    writeAccounts(chemin, fichier());
    const users = new LocalUserStore(baseIndisponible, chemin);
    return { users, sessions: new LocalSessionStore(baseIndisponible, users) };
  }

  it('crée une session retrouvable par son jeton brut', async () => {
    const { sessions } = stores();

    const jeton = await sessions.create(ID_ALICE, 60_000, null, null);
    const session = await sessions.findByRawToken(jeton);

    expect(session?.user_id).toBe(ID_ALICE);
    expect(session?.revoked).toBe(0);
  });

  it('JOINT les données du compte, dont dépend la révocation', async () => {
    // `token_version`, `rank` et `status` viennent du COMPTE : les omettre
    // rendrait un jeton révoqué à nouveau valable.
    const { sessions } = stores();

    const session = await sessions.findByRawToken(
      await sessions.create(ID_ALICE, 60_000, null, null),
    );

    expect(session).toMatchObject({ token_version: 3, rank: 50, status: 'active' });
  });

  it('rend null pour un jeton inconnu', async () => {
    const { sessions } = stores();

    expect(await sessions.findByRawToken('jeton-inexistant')).toBeNull();
  });

  it('rend null quand le compte a disparu', async () => {
    const { sessions } = stores();
    const jeton = await sessions.create(ID_ALICE, 60_000, null, null);

    writeAccounts(chemin, { version: 1, accounts: [] });

    expect(await sessions.findByRawToken(jeton)).toBeNull();
  });

  it('RÉVOQUE l’ancienne session à la rotation — un jeton ne sert qu’une fois', async () => {
    const { sessions } = stores();
    const premier = await sessions.create(ID_ALICE, 60_000, null, null);
    const session = await sessions.findByRawToken(premier);

    const second = await sessions.rotate(session!.session_id, ID_ALICE, 60_000, null, null);

    expect((await sessions.findByRawToken(premier))?.revoked).toBe(1);
    expect((await sessions.findByRawToken(second))?.revoked).toBe(0);
  });

  it('ne révoque QUE la session présentée à la rotation', async () => {
    // Une rotation qui emporterait les autres sessions déconnecterait
    // l'utilisateur de ses autres appareils à chaque rafraîchissement.
    const { sessions } = stores();
    const premier = await sessions.create(ID_ALICE, 60_000, null, null);
    const autre = await sessions.create(ID_ALICE, 60_000, null, null);
    const session = await sessions.findByRawToken(premier);

    await sessions.rotate(session!.session_id, ID_ALICE, 60_000, null, null);

    expect((await sessions.findByRawToken(autre))?.revoked).toBe(0);
  });

  it('révoque toutes les sessions d’un compte', async () => {
    const { sessions } = stores();
    const a = await sessions.create(ID_ALICE, 60_000, null, null);
    await sessions.create(ID_ALICE, 60_000, null, null);

    expect(await sessions.revokeAllForUser(ID_ALICE)).toBe(2);
    expect((await sessions.findByRawToken(a))?.revoked).toBe(1);
    // Une seconde révocation ne compte plus celles qui l'étaient déjà.
    expect(await sessions.revokeAllForUser(ID_ALICE)).toBe(0);
  });

  it('purge les sessions expirées, et elles seules', async () => {
    const { sessions } = stores();
    const perime = await sessions.create(ID_ALICE, -1_000, null, null);
    const vivant = await sessions.create(ID_ALICE, 60_000, null, null);

    expect(await sessions.deleteExpired()).toBe(1);
    expect(await sessions.findByRawToken(perime)).toBeNull();
    expect(await sessions.findByRawToken(vivant)).not.toBeNull();
  });
});

describe('LocalPermissionStore', () => {
  it('N’ACCORDE aucune permission fine — le rang seul décide', async () => {
    // Les permissions par gamme vivent en base ; les inventer ici donnerait
    // des droits que la v1 n'accordait pas davantage.
    const depot = new LocalPermissionStore(baseIndisponible);

    expect(await depot.findAllForUser()).toEqual([]);
    expect(await depot.findOne()).toBeNull();
  });
});
