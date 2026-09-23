import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PERMISSIONS,
  UsageQuerySchema,
  type UsageGovernance,
  type UsageOverview,
  type UsageQuery,
} from '@websentry/shared';
import { RequirePermission } from '../common/decorators/index.js';
import { UsageService } from './usage.service.js';

/**
 * Analytics d'usage et gouvernance.
 *
 * Deux routes, toutes deux en LECTURE. Le module n'offre aucune écriture, et
 * pas même un déclenchement manuel de l'anonymisation : la seule façon de la
 * lancer est le minuteur. Une route de déclenchement serait une porte vers la
 * seule opération capable de modifier le journal d'audit — c'est exactement ce
 * qu'on refuse d'ouvrir.
 *
 * `usage:read` est le code de la v1, accordé par défaut aux rangs 50 et 100.
 * Il garde les deux routes : le registre de traitement dit ce que
 * l'application conserve, et cela ne regarde pas tous les comptes.
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @RequirePermission(PERMISSIONS.USAGE_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  overview(@Query({ schema: UsageQuerySchema }) requete: UsageQuery): Promise<UsageOverview> {
    return this.usage.overview(requete.periode);
  }

  @RequirePermission(PERMISSIONS.USAGE_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('gouvernance')
  governance(): Promise<UsageGovernance> {
    return this.usage.governance();
  }
}
