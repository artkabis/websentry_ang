import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as z from 'zod';
import {
  CreateUserSchema,
  GrantPermissionSchema,
  PERMISSIONS,
  PermissionCodeSchema,
  ResetPasswordSchema,
  UpdateUserSchema,
  UserListQuerySchema,
  type CreateUserInput,
  type GrantPermissionInput,
  type ResetPasswordInput,
  type UpdateUserInput,
  type UserListQuery,
  type UserListResponse,
  type UserPermission,
  type UserSummary,
} from '@websentry/shared';
import { CurrentUser, RequirePermission } from '../common/decorators/index.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import { UsersService, type Actor } from './users.service.js';

const IdParamSchema = z.uuid();

/**
 * Gestion des comptes.
 *
 * Les lectures et les écritures ne portent pas la même permission : consulter
 * la liste des comptes (`users:read`) est utile à qui pilote l'outil, alors que
 * créer, modifier ou supprimer (`users:write`, `users:delete`) engage la
 * sécurité de l'instance. Les garde-fous de rang, eux, sont dans le service —
 * ils dépendent de l'acteur ET de la cible, ce qu'une garde de route ne voit
 * pas.
 *
 * Le débit est limité plus sévèrement que sur les autres modules : ces routes
 * énumèrent des comptes et en changent les mots de passe.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  private actorOf(req: AuthenticatedRequest, user: AuthUser): Actor {
    return { id: user.sub, username: user.username, rank: user.rank, ipAddress: req.ip ?? null };
  }

  @RequirePermission(PERMISSIONS.USERS_READ)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(@Query({ schema: UserListQuerySchema }) query: UserListQuery): Promise<UserListResponse> {
    return this.users.list(query);
  }

  @RequirePermission(PERMISSIONS.USERS_READ)
  @Get(':id')
  get(@Param('id', { schema: IdParamSchema }) id: string): Promise<UserSummary> {
    return this.users.get(id);
  }

  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(
    @Body({ schema: CreateUserSchema }) body: CreateUserInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<UserSummary> {
    return this.users.create(body, this.actorOf(req, user));
  }

  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  update(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: UpdateUserSchema }) body: UpdateUserInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<UserSummary> {
    return this.users.update(id, body, this.actorOf(req, user));
  }

  /**
   * Réinitialisation du mot de passe — route DISTINCTE de la modification.
   *
   * Mêler le mot de passe aux autres champs permettrait de le changer par
   * inadvertance en corrigeant un courriel, et rendrait la trace d'audit
   * ambiguë sur ce qui a réellement été fait.
   */
  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: ResetPasswordSchema }) body: ResetPasswordInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.resetPassword(id, body.password, this.actorOf(req, user));
  }

  @RequirePermission(PERMISSIONS.USERS_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', { schema: IdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.remove(id, this.actorOf(req, user));
  }

  @RequirePermission(PERMISSIONS.USERS_READ)
  @Get(':id/permissions')
  listPermissions(@Param('id', { schema: IdParamSchema }) id: string): Promise<UserPermission[]> {
    return this.users.listPermissions(id);
  }

  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put(':id/permissions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async grantPermission(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: GrantPermissionSchema }) body: GrantPermissionInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.grantPermission(id, body, this.actorOf(req, user));
  }

  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id/permissions/:permission')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Param('permission', { schema: PermissionCodeSchema }) permission: string,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.revokePermission(id, permission, this.actorOf(req, user));
  }
}
