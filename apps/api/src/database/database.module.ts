import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { LocalAccountsBootstrap } from '../auth/local/local-accounts.bootstrap.js';
import {
  LocalPermissionStore,
  LocalSessionStore,
  LocalUserStore,
} from '../auth/local/local-stores.js';
import { DatabaseService } from './database.service.js';
import { UserAdminRepository } from './repositories/user-admin.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { PermissionRepository } from './repositories/permission.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { FeedbackRepository } from './repositories/feedback.repository.js';
import { SupervisionRepository } from './repositories/supervision.repository.js';
import { MessageRepository } from './repositories/message.repository.js';
import { UsageRepository } from './repositories/usage.repository.js';
import { ProfileRepository } from './repositories/profile.repository.js';
import { ScanRepository } from './repositories/scan.repository.js';
import { ScanRetentionRepository } from './repositories/scan-retention.repository.js';
import { ScanTrashRepository } from './repositories/scan-trash.repository.js';

/**
 * Dépôts d'authentification, selon qu'il y ait une base ou non.
 *
 * `DB_ENABLED=false` sert à travailler sans MariaDB — la v1 le permettait avec
 * un compte `admin` et un compte `tester`. Les implémentations locales portent
 * le MÊME jeton d'injection : ni l'authentification ni le RBAC ne savent
 * laquelle ils reçoivent, et rien d'autre ne change de comportement.
 */
const DEPOTS_AUTH = [
  {
    provide: UserRepository,
    inject: [AppConfigService, DatabaseService],
    useFactory: (config: AppConfigService, db: DatabaseService): UserRepository =>
      config.dbEnabled ? new UserRepository(db) : new LocalUserStore(db),
  },
  {
    provide: SessionRepository,
    inject: [AppConfigService, DatabaseService, UserRepository],
    useFactory: (
      config: AppConfigService,
      db: DatabaseService,
      users: UserRepository,
    ): SessionRepository =>
      config.dbEnabled ? new SessionRepository(db) : new LocalSessionStore(db, users),
  },
  {
    provide: PermissionRepository,
    inject: [AppConfigService, DatabaseService],
    useFactory: (config: AppConfigService, db: DatabaseService): PermissionRepository =>
      config.dbEnabled ? new PermissionRepository(db) : new LocalPermissionStore(db),
  },
];

@Global()
@Module({
  providers: [
    DatabaseService,
    ...DEPOTS_AUTH,
    UserAdminRepository,
    LocalAccountsBootstrap,
    AuditRepository,
    FeedbackRepository,
    SupervisionRepository,
    MessageRepository,
    UsageRepository,
    ProfileRepository,
    ScanRepository,
    ScanRetentionRepository,
    ScanTrashRepository,
  ],
  exports: [
    DatabaseService,
    UserRepository,
    UserAdminRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
    FeedbackRepository,
    SupervisionRepository,
    MessageRepository,
    UsageRepository,
    ProfileRepository,
    ScanRepository,
    ScanRetentionRepository,
    ScanTrashRepository,
  ],
})
export class DatabaseModule {}
