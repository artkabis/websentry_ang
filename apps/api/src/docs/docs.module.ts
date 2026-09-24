import { Module } from '@nestjs/common';
import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';

/**
 * Module 10 — portail documentation.
 *
 * Aucun dépôt de base de données : les pages sont des fichiers du projet, lus
 * au démarrage. Le module fonctionne donc même sans MariaDB — ce qui est
 * exactement ce qu'on attend d'une documentation.
 */
@Module({
  controllers: [DocsController],
  providers: [DocsService],
})
export class DocsModule {}
