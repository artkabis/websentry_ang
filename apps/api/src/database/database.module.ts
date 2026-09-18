import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { PermissionRepository } from './repositories/permission.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { ProfileRepository } from './repositories/profile.repository.js';

@Global()
@Module({
  providers: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
    ProfileRepository,
  ],
  exports: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
    ProfileRepository,
  ],
})
export class DatabaseModule {}
