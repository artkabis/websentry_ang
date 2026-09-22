import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generatePassword,
  readAccounts,
  upsertAccount,
  writeAccounts,
  type LocalAccountsFile,
} from './local-accounts.js';

let chemin: string;
beforeEach(() => {
  chemin = join(mkdtempSync(join(tmpdir(), 'ws-comptes-')), 'comptes.json');
});

const VIDE: LocalAccountsFile = { version: 1, accounts: [] };

describe('fichier de comptes locaux', () => {
  it('rend un contenu vide quand le fichier n’existe pas', () => {
    expect(readAccounts(chemin)).toEqual(VIDE);
  });

  it('REFUSE un fichier illisible plutôt que de repartir de zéro', () => {
    // Effacer en silence les comptes de quelqu'un parce qu'une accolade manque
    // serait pire que refuser de démarrer.
    writeFileSync(chemin, '{ "version": 1, "accounts": [ { "username": "sans-id" } ] }');

    expect(() => readAccounts(chemin)).toThrow(/illisible/);
  });

  it('REFUSE un mot de passe en clair', () => {
    // L'empreinte a une forme précise ; une chaîne quelconque à cette place
    // serait un mot de passe écrit en clair dans un fichier.
    writeFileSync(
      chemin,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            username: 'alice',
            passwordHash: 'motdepasse',
            rank: 50,
          },
        ],
      }),
    );

    expect(() => readAccounts(chemin)).toThrow(/Empreinte de mot de passe invalide/);
  });

  it('relit ce qu’il a écrit', () => {
    const fichier = upsertAccount(VIDE, { username: 'alice', passwordHash: 'aa:bb', rank: 50 });
    writeAccounts(chemin, fichier);

    expect(readAccounts(chemin)).toEqual(fichier);
  });

  it('écrit un fichier lisible par son seul propriétaire', () => {
    // Il ne porte que des empreintes, mais une empreinte se soumet hors ligne
    // à une attaque par dictionnaire.
    writeAccounts(chemin, VIDE);

    expect(statSync(chemin).mode & 0o077).toBe(0);
  });
});

describe('création et mise à jour d’un compte', () => {
  it('crée un compte actif', () => {
    const fichier = upsertAccount(VIDE, { username: 'alice', passwordHash: 'aa:bb', rank: 50 });

    expect(fichier.accounts).toHaveLength(1);
    expect(fichier.accounts[0]).toMatchObject({ username: 'alice', rank: 50, status: 'active' });
  });

  it('CONSERVE l’identifiant technique d’un compte existant', () => {
    // Les sessions le référencent : le changer déconnecterait sans raison.
    const initial = upsertAccount(VIDE, { username: 'alice', passwordHash: 'aa:bb', rank: 50 });

    const suivant = upsertAccount(initial, {
      username: 'alice',
      passwordHash: 'cc:dd',
      rank: 100,
    });

    expect(suivant.accounts[0]?.id).toBe(initial.accounts[0]?.id);
    expect(suivant.accounts).toHaveLength(1);
  });

  it('INVALIDE les sessions ouvertes quand le mot de passe change', () => {
    // Changer un mot de passe sans révoquer laisserait un accès ouvert à qui
    // détenait l'ancien.
    const initial = upsertAccount(VIDE, { username: 'alice', passwordHash: 'aa:bb', rank: 50 });

    const suivant = upsertAccount(initial, { username: 'alice', passwordHash: 'cc:dd', rank: 50 });

    expect(suivant.accounts[0]?.tokenVersion).toBe((initial.accounts[0]?.tokenVersion ?? 0) + 1);
  });

  it('lève le verrou d’un compte dont on réinitialise le mot de passe', () => {
    const verrouille: LocalAccountsFile = {
      version: 1,
      accounts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          username: 'alice',
          passwordHash: 'aa:bb',
          rank: 50,
          status: 'suspended',
          tokenVersion: 2,
          failedLogins: 5,
          lockedUntil: '2026-01-01T10:00:00.000Z',
        },
      ],
    };

    const suivant = upsertAccount(verrouille, {
      username: 'alice',
      passwordHash: 'cc:dd',
      rank: 50,
    });

    expect(suivant.accounts[0]).toMatchObject({
      status: 'active',
      failedLogins: 0,
      lockedUntil: null,
    });
  });
});

describe('mot de passe initial', () => {
  it('n’est jamais deux fois le même', () => {
    // Un mot de passe par défaut écrit dans le dépôt serait connu de tous et
    // finirait sur une instance exposée.
    const tirages = new Set(Array.from({ length: 50 }, () => generatePassword()));

    expect(tirages.size).toBe(50);
  });

  it('porte assez d’entropie pour ne pas se deviner', () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(16);
  });
});
