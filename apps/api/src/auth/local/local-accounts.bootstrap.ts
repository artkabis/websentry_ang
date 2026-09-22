import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { PasswordService } from '../../security/password.service.js';
import {
  LOCAL_ADMIN_RANK,
  LOCAL_TESTER_RANK,
  accountsFilePath,
  generatePassword,
  readAccounts,
  upsertAccount,
  writeAccounts,
} from './local-accounts.js';

/**
 * Sème les deux comptes du mode « sans base », au premier démarrage.
 *
 * La v1 offrait un `admin` et un `tester` sans MariaDB ; ce sont les deux
 * mêmes. Leur mot de passe est TIRÉ AU SORT et affiché une seule fois : un mot
 * de passe par défaut écrit dans le dépôt serait connu de tous, et finirait un
 * jour sur une instance exposée.
 *
 * Rien n'est semé si le fichier existe déjà — sans quoi chaque redémarrage
 * changerait les mots de passe.
 */
@Injectable()
export class LocalAccountsBootstrap implements OnModuleInit {
  private readonly logger = new Logger('ComptesLocaux');

  constructor(
    private readonly config: AppConfigService,
    private readonly passwords: PasswordService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.dbEnabled) return;

    const chemin = accountsFilePath();
    let fichier = readAccounts(chemin);
    if (fichier.accounts.length > 0) {
      this.logger.log(`${fichier.accounts.length} compte(s) local(aux) — ${chemin}`);
      return;
    }

    const crees: { username: string; password: string }[] = [];
    for (const [username, rank] of [
      ['admin', LOCAL_ADMIN_RANK],
      ['tester', LOCAL_TESTER_RANK],
    ] as const) {
      const password = generatePassword();
      fichier = upsertAccount(fichier, {
        username,
        passwordHash: await this.passwords.hash(password),
        rank,
      });
      crees.push({ username, password });
    }
    writeAccounts(chemin, fichier);

    // Affiché une fois, ici seulement : le fichier ne garde que l'empreinte, et
    // personne ne pourra retrouver ces mots de passe ensuite.
    this.logger.warn('Mode sans base — comptes locaux créés, notez ces mots de passe :');
    for (const { username, password } of crees) {
      this.logger.warn(`  ${username} / ${password}`);
    }
    this.logger.warn(
      `Pour en changer : pnpm --filter @websentry/api dev:user ${crees[0]?.username} '…'`,
    );
  }
}
