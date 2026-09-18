import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Conflit de verrouillage optimiste.
 *
 * Porte la version courante pour que le client puisse se resynchroniser sans
 * un aller-retour supplémentaire — recharger, rejouer, resoumettre.
 */
export class ProfileVersionConflictError extends ConflictException {
  constructor(
    readonly gamme: string,
    readonly currentVersion: number,
    readonly expectedVersion: number,
  ) {
    super({
      statusCode: 409,
      error: 'Conflit de version',
      message:
        `Le profil ${gamme} a été modifié entre-temps ` +
        `(version courante ${currentVersion}, version soumise ${expectedVersion}). ` +
        'Rechargez-le avant de soumettre vos modifications.',
      details: { currentVersion, expectedVersion },
    });
  }
}

export class ProfileNotFoundError extends NotFoundException {
  constructor(gamme: string) {
    super(`Profil introuvable : ${gamme}`);
  }
}

/** Le profil de repli ne peut pas être supprimé : sans lui, plus aucun repli. */
export class DefaultProfileProtectedError extends ForbiddenException {
  constructor() {
    super('Le profil « default » est le repli universel et ne peut pas être supprimé');
  }
}
