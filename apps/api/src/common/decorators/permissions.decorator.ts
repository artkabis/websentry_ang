import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '@websentry/shared';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Exige une permission fine.
 *
 * À combiner avec `@MinRank()` quand la route doit ÉGALEMENT être réservée à un
 * rang : les deux gardes s'appliquent alors en conjonction (rang ET permission).
 */
export const RequirePermission = (code: PermissionCode) => SetMetadata(PERMISSIONS_KEY, code);
