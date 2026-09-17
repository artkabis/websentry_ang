import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { SecurityModule } from '../security/security.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    RbacModule,
    SecurityModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        // Algorithme épinglé au niveau du module : aucune route ne peut émettre
        // un jeton signé autrement (parade à la confusion d'algorithme).
        signOptions: { algorithm: 'HS256', expiresIn: config.accessTokenTtl },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, LoginThrottleService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
