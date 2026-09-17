import { SetMetadata } from '@nestjs/common';
import { RANKS } from '@websentry/shared';

export const MIN_RANK_KEY = 'minRank';

/**
 * Exige un rang MINIMAL. La hiérarchie étant un ordre total, un seuil suffit —
 * pas besoin d'énumérer les rôles autorisés.
 */
export const MinRank = (rank: number) => SetMetadata(MIN_RANK_KEY, rank);

/** Raccourcis lisibles pour les seuils usuels. */
export const RequireAdmin = () => MinRank(RANKS.ADMIN);
export const RequireSuperAdmin = () => MinRank(RANKS.SUPER_ADMIN);
export const RequireEditor = () => MinRank(RANKS.EDITOR);
