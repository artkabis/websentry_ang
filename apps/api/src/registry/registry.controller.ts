import { Controller, Get } from '@nestjs/common';
import {
  ALL_CHECKS,
  REGISTRY_STATS,
  SUB_CHECKS_REGISTRY,
  type RegistryResponse,
  type RegistryStats,
} from '@websentry/shared';

/**
 * Registre des critères et sous-critères.
 *
 * Servi depuis le paquet partagé, donc sans accès en base : l'éditeur de
 * profils affiche les critères disponibles sans qu'un déploiement du frontend
 * soit nécessaire à chaque ajout côté backend.
 */
@Controller('registry')
export class RegistryController {
  /** GET /api/v1/registry — accessible à tout compte authentifié. */
  @Get()
  get(): RegistryResponse {
    return { checks: ALL_CHECKS, subChecks: SUB_CHECKS_REGISTRY };
  }

  /** GET /api/v1/registry/stats — volumétrie, pour les tableaux de bord. */
  @Get('stats')
  stats(): RegistryStats {
    return REGISTRY_STATS;
  }
}
