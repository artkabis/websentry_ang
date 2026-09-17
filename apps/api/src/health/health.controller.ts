import { Controller, Get } from '@nestjs/common';
import type { Health } from '@websentry/shared';
import { Public } from '../common/decorators/index.js';

/**
 * Sonde publique.
 *
 * La réponse est délibérément pauvre : ni version de dépendances, ni état de la
 * base, ni nom d'hôte. Une sonde bavarde est un outil de reconnaissance offert
 * gratuitement (OWASP #7).
 */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): Health {
    return { ok: true, version: '2.0.0' };
  }
}
