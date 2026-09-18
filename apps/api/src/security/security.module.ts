import { Global, Module } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard.js';
import { PasswordService } from './password.service.js';
import { SsrfService } from './ssrf.service.js';

@Global()
@Module({
  providers: [PasswordService, SsrfService, CsrfGuard],
  exports: [PasswordService, SsrfService, CsrfGuard],
})
export class SecurityModule {}
