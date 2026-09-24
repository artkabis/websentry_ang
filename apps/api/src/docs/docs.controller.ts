import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  DocSearchQuerySchema,
  DocSlugSchema,
  PERMISSIONS,
  type DocIndex,
  type DocPage,
  type DocSearchQuery,
  type DocSearchResponse,
} from '@websentry/shared';
import { RequirePermission } from '../common/decorators/index.js';
import { DocsService } from './docs.service.js';

/**
 * Portail de documentation.
 *
 * Trois lectures, aucune écriture : les pages vivent dans le dépôt et se
 * modifient par une revue de code, pas par une route.
 *
 * `docs:read` est le code de la v1, accordé par défaut aux rangs 50 et 100.
 * Il est CONSERVÉ tel quel : l'ouvrir à tous serait un assouplissement d'un
 * contrôle d'accès existant, ce qui se décide, pas ce qui se glisse dans une
 * migration. Le point est consigné dans `DECISIONS.md`.
 */
@Controller('docs')
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @RequirePermission(PERMISSIONS.DOCS_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  index(): DocIndex {
    return this.docs.index();
  }

  /**
   * Recherche AVANT la route par identifiant : « recherche » est un
   * identifiant valide au regard du schéma, et l'ordre de déclaration décide.
   */
  @RequirePermission(PERMISSIONS.DOCS_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('recherche')
  rechercher(@Query({ schema: DocSearchQuerySchema }) requete: DocSearchQuery): DocSearchResponse {
    return this.docs.rechercher(requete.q, requete.limit);
  }

  @RequirePermission(PERMISSIONS.DOCS_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':slug')
  page(@Param('slug', { schema: DocSlugSchema }) slug: string): DocPage {
    return this.docs.page(slug);
  }
}
