import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuditQuerySchema, type AuditListResponse, type AuditQuery } from '@websentry/shared';
import { RequireSuperAdmin } from '../common/decorators/index.js';
import { AuditService } from './audit.service.js';

/**
 * Lecture du journal d'audit.
 *
 * Gardée par le RANG 100 et non par `audit:read` : ce code existe au catalogue
 * mais reste réservé — il n'est accordable à personne d'autre, et une garde par
 * permission laisserait croire qu'on peut le déléguer. Le journal porte des
 * adresses IP et le détail des actions menées sur les comptes ; c'est une pièce
 * d'enquête, pas une donnée d'exploitation courante.
 *
 * Aucune route d'écriture ni de purge : le dépôt n'expose ni UPDATE ni DELETE,
 * et la contrainte reste structurelle jusqu'ici.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequireSuperAdmin()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  list(@Query({ schema: AuditQuerySchema }) requete: AuditQuery): Promise<AuditListResponse> {
    return this.audit.list(requete);
  }
}
