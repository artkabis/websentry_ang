import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { PermissionRepository } from './repositories/permission.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';

@Global()
@Module({
  providers: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
  ],
  exports: [
    DatabaseService,
    UserRepository,
    SessionRepository,
    PermissionRepository,
    AuditRepository,
  ],
})
export class DatabaseModule {}
