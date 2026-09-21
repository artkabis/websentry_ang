import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { validateEnv } from './env.schema.js';

/**
 * Où chercher le fichier d'environnement, DANS CET ORDRE.
 *
 * Les chemins sont résolus depuis le répertoire courant, et les scripts
 * s'exécutent dans `apps/api`. Sans les deux derniers, un `.env` placé à la
 * racine du dépôt — là où `.env.example` invite à le copier — n'était jamais
 * lu : le démarrage échouait sur « JWT_SECRET manquant » alors que le fichier
 * existait, à deux dossiers de là.
 *
 * Exporté pour être testé : c'est une liste de chaînes, et rien dans le code
 * ne dirait qu'elle a été raccourcie.
 */
export const ENV_FILES: readonly string[] = [
  '.env.local',
  '.env',
  '../../.env.local',
  '../../.env',
];

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
