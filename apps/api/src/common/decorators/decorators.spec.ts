import { RANKS } from '@websentry/shared';
import { describe, expect, it } from 'vitest';
import { mockExecutionContext } from '../../testing/execution-context.mock.js';
import { CurrentUser } from './current-user.decorator.js';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';
import { PERMISSIONS_KEY, RequirePermission } from './permissions.decorator.js';
import {
  MIN_RANK_KEY,
  MinRank,
  RequireAdmin,
  RequireEditor,
  RequireSuperAdmin,
} from './roles.decorator.js';
import { SKIP_CSRF_KEY, SkipCsrf } from './skip-csrf.decorator.js';

/**
 * Les décorateurs Nest posent des métadonnées lues par les gardes. On vérifie ici
 * la CLÉ et la VALEUR posées : une faute de frappe rendrait le décorateur
 * silencieusement inopérant — et donc, pour `@MinRank`, une route ouverte.
 */
function metadataOf(decorator: MethodDecorator | ClassDecorator, key: string): unknown {
  class Target {}
  (decorator as ClassDecorator)(Target);
  return Reflect.getMetadata(key, Target);
}

describe('décorateurs d’autorisation', () => {
  it('@Public() marque la route comme ouverte', () => {
    expect(metadataOf(Public(), IS_PUBLIC_KEY)).toBe(true);
  });

  it('@SkipCsrf() marque la route comme exemptée', () => {
    expect(metadataOf(SkipCsrf(), SKIP_CSRF_KEY)).toBe(true);
  });

  it('@MinRank() pose le seuil demandé', () => {
    expect(metadataOf(MinRank(42), MIN_RANK_KEY)).toBe(42);
  });

  it.each([
    [RequireAdmin, RANKS.ADMIN, 'admin'],
    [RequireSuperAdmin, RANKS.SUPER_ADMIN, 'super_admin'],
    [RequireEditor, RANKS.EDITOR, 'editor'],
  ])('le raccourci %# pose le seuil %s (%s)', (decorator, expected, _label) => {
    expect(metadataOf(decorator(), MIN_RANK_KEY)).toBe(expected);
  });

  it('@RequirePermission() pose le code demandé', () => {
    expect(metadataOf(RequirePermission('users:read'), PERMISSIONS_KEY)).toBe('users:read');
  });
});

describe('@CurrentUser()', () => {
  /**
   * Rejoue la fabrique du décorateur de paramètre directement, plutôt que de
   * monter un contrôleur complet : Nest la range dans les métadonnées de route.
   */
  function invoke(ctx: ReturnType<typeof mockExecutionContext>): unknown {
    class Probe {
      handler(@CurrentUser() user: unknown): unknown {
        return user;
      }
    }

    const routeArgs = Reflect.getMetadata('__routeArguments__', Probe, 'handler') as Record<
      string,
      { factory: (data: unknown, ctx: unknown) => unknown }
    >;
    const [entry] = Object.values(routeArgs);
    if (!entry) throw new Error('métadonnée de paramètre introuvable');
    return entry.factory(undefined, ctx);
  }

  it('restitue l’identité déposée par la garde', () => {
    const user = { sub: 'u1', username: 'alice', rank: RANKS.ADMIN, version: 0 };
    expect(invoke(mockExecutionContext({ authUser: user }))).toEqual(user);
  });

  it('lève sur une route non gardée — un undefined propagé serait pire', () => {
    expect(() => invoke(mockExecutionContext({ authUser: undefined }))).toThrow(
      /route non authentifiée/,
    );
  });
});
