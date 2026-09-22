import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service.js';
import { PasswordService } from '../../security/password.service.js';
import { LocalAccountsBootstrap } from './local-accounts.bootstrap.js';
import { accountsFilePath, readAccounts, upsertAccount, writeAccounts } from './local-accounts.js';

const passwords = new PasswordService();

function bootstrap(dbEnabled: boolean) {
  return new LocalAccountsBootstrap({ dbEnabled } as AppConfigService, passwords);
}

let dossier: string;
let cwd: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'ws-boot-'));
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(dossier);
});
afterEach(() => cwd.mockRestore());

describe('semis des comptes locaux', () => {
  it('crée admin et tester au premier démarrage', async () => {
    // Les deux comptes de la v1, aux mêmes rangs.
    await bootstrap(false).onModuleInit();

    const comptes = readAccounts(accountsFilePath()).accounts;
    expect(comptes.map(compte => [compte.username, compte.rank])).toEqual([
      ['admin', 50],
      ['tester', 10],
    ]);
  });

  it('donne des mots de passe UTILISABLES, et tirés au sort', async () => {
    const avertissements: string[] = [];
    const bootstrapper = bootstrap(false);
    vi.spyOn(
      bootstrapper as unknown as { logger: { warn: (message: string) => void } },
      'logger',
      'get',
    ).mockReturnValue({ warn: (message: string) => avertissements.push(message) });

    await bootstrapper.onModuleInit();

    const annonce = avertissements.find(ligne => ligne.trim().startsWith('admin /'));
    const motDePasse = annonce?.split('/')[1]?.trim() ?? '';
    const compte = readAccounts(accountsFilePath()).accounts.find(
      item => item.username === 'admin',
    );

    // Le mot de passe annoncé doit ouvrir le compte : une annonce qui ne
    // correspond pas au fichier vaut pire que pas d'annonce du tout.
    expect(await passwords.verify(motDePasse, compte!.passwordHash)).toBe(true);
  });

  it('NE RESÈME PAS quand des comptes existent déjà', async () => {
    // Sans cela, chaque redémarrage changerait les mots de passe.
    const existant = upsertAccount(
      { version: 1, accounts: [] },
      { username: 'alice', passwordHash: 'aa:bb', rank: 50 },
    );
    writeAccounts(accountsFilePath(), existant);

    await bootstrap(false).onModuleInit();

    expect(readAccounts(accountsFilePath())).toEqual(existant);
  });

  it('ne fait RIEN quand une base est configurée', async () => {
    // Les comptes vivent alors en base : en écrire ici créerait une seconde
    // source de vérité, et des identifiants qui survivraient à la bascule.
    await bootstrap(true).onModuleInit();

    expect(readAccounts(accountsFilePath()).accounts).toEqual([]);
  });
});
