import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { ENV_FILES } from './env-files.js';
import { validateEnv } from './env.schema.js';

/**
 * Configuration globale — la validation Zod s'exécute au chargement du module,
 * donc avant l'instanciation de tout autre provider.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: [...ENV_FILES],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
