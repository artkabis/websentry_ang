import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';
import { SettingsController } from '../settings/settings.controller.js';
import { RegistryController } from '../registry/registry.controller.js';

/**
 * Module 2 — réglages et profils par gamme.
 *
 * Les trois contrôleurs partagent le même service : les réglages globaux ne
 * sont qu'une vue sur le profil `default`, et le registre alimente l'éditeur
 * qui les manipule.
 */
@Module({
  controllers: [ProfilesController, SettingsController, RegistryController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule implements OnApplicationBootstrap {
  constructor(private readonly profiles: ProfilesService) {}

  /**
   * Garantit l'existence du profil de repli au démarrage.
   *
   * `onApplicationBootstrap` et non `onModuleInit` : la connexion à la base est
   * établie pendant l'initialisation des modules, et l'ordre entre eux n'est pas
   * garanti. Ce hook s'exécute une fois tous les modules prêts.
   *
   * Un échec ici n'empêche PAS le démarrage : le service sait retomber sur les
   * défauts du schéma, et refuser de démarrer pour cette raison rendrait l'API
   * indisponible là où elle pourrait encore servir.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.profiles.ensureDefaultProfile().catch(() => undefined);
  }
}
