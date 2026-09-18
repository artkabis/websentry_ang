import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { AppConfigService } from './config/app-config.service.js';

/**
 * Point d'entrée du serveur.
 *
 * Toute erreur au démarrage (environnement invalide, base injoignable) fait sortir
 * le processus en code 1 : on ne laisse jamais tourner un serveur à moitié
 * configuré, qui répondrait avec un dispositif de sécurité incomplet.
 */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get(AppConfigService);

  await app.listen({ port: config.port, host: config.host });

  Logger.log(
    `WebSentry API v2 à l'écoute sur ${config.host}:${config.port} (${config.nodeEnv})`,
    'Bootstrap',
  );
}

void bootstrap().catch((err: unknown) => {
  // `console.error` et non le logger Nest : à ce stade l'application peut ne pas
  // être construite, donc aucun logger injecté n'est disponible.
  console.error('Démarrage impossible :', err instanceof Error ? err.message : err);
  process.exit(1);
});
