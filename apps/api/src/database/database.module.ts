import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { PermissionRepository } from './repositories/permission.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { ProfileRepository } from './repositories/profile.repository.js';
import { ScanRepository } from './repositories/scan.repository.js';
import { ScanRetentionRepository } from './repositories/scan-retention.repository.js';

@Global()
@Module({
  providers: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
    ProfileRepository,
    ScanRepository,
    ScanRetentionRepository,
  ],
  exports: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
    ProfileRepository,
    ScanRepository,
    ScanRetentionRepository,
  ],
})
export class DatabaseModule {}
