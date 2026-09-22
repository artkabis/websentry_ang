import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AnalysisModule } from './analysis/analysis.module.js';
import { AppConfigModule } from './config/config.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './auth/guards/permissions.guard.js';
import { RankGuard } from './auth/guards/rank.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { UsersModule } from './users/users.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { SupervisionModule } from './supervision/supervision.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { ScansModule } from './scans/scans.module.js';
import { CsrfGuard } from './security/csrf.guard.js';
import { SecurityModule } from './security/security.module.js';

/**
 * Module racine.
 *
 * L'ORDRE des gardes globales est significatif — Nest les exécute dans l'ordre de
 * déclaration :
 *   1. ThrottlerGuard   — repousser l'abus avant d'engager le moindre calcul ;
 *   2. JwtAuthGuard     — résout `req.authUser` et `req.authVia` ;
 *   3. CsrfGuard        — a besoin de `authVia` pour exempter les clients Bearer ;
 *   4. RankGuard        — a besoin de `authUser.rank` ;
 *   5. PermissionsGuard — a besoin de `authUser` et interroge la base.
 *
 * Toutes sont GLOBALES : une route est fermée par défaut et ne s'ouvre que par un
 * décorateur explicite. L'oubli d'une garde ne peut donc pas exposer un endpoint.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuditModule,
    SecurityModule,
    RbacModule,
    AuthModule,
    HealthModule,
    ProfilesModule,
    UsersModule,
    FeedbackModule,
    SupervisionModule,
    ScansModule,
    AnalysisModule,
    ThrottlerModule.forRoot({
      throttlers: [
        // Garde volumétrique par défaut ; les routes sensibles resserrent la limite
        // via @Throttle() (login : 50 / 15 min).
        { name: 'default', ttl: 60_000, limit: 120 },
      ],
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Validation globale par Standard Schema — Nest 12 consomme directement les
    // schémas Zod, sans couche d'adaptation tierce (cf. docs/DECISIONS.md).
    {
      provide: APP_PIPE,
      useFactory: () =>
        new StandardSchemaValidationPipe({
          // Les valeurs coercées/transformées par le schéma remplacent l'entrée brute.
          transform: true,
        }),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RankGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
