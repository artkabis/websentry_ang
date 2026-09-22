import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PERMISSIONS, type Supervision } from '@websentry/shared';
import { RequirePermission } from '../common/decorators/index.js';
import { SupervisionService } from './supervision.service.js';

/**
 * Supervision — état réel de l'instance.
 *
 * Gardée par `health:read`, que le rang administrateur détient par défaut :
 * c'est une donnée d'EXPLOITATION, pas une pièce d'enquête comme le journal
 * d'audit. Qui pilote l'outil doit pouvoir constater qu'un pool est tombé sans
 * attendre le rang le plus élevé.
 *
 * La sonde publique `/health` reste, elle, délibérément pauvre : ni version de
 * dépendances, ni état de la base, ni nom d'hôte. C'est la même information
 * sous deux régimes d'accès, et les confondre reviendrait à offrir un outil de
 * reconnaissance (OWASP #7).
 */
@Controller('supervision')
export class SupervisionController {
  constructor(private readonly supervision: SupervisionService) {}

  @RequirePermission(PERMISSIONS.HEALTH_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  releve(): Promise<Supervision> {
    return this.supervision.releve();
  }
}
