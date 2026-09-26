import { afterEach, describe, expect, it } from 'vitest';
import { reglages } from './base.js';

/**
 * Les garde-fous du harnais.
 *
 * Ces suites VIDENT les tables. Deux erreurs sont donc à rendre impossibles :
 * tourner sans base — auquel cas il faut échouer et non se déclarer ignoré — et
 * tourner sur la base de développement de quelqu'un.
 */
describe('garde-fous du harnais d’intégration', () => {
  const initial = process.env.INTEGRATION_DB_NAME;

  afterEach(() => {
    if (initial === undefined) delete process.env.INTEGRATION_DB_NAME;
    else process.env.INTEGRATION_DB_NAME = initial;
  });

  it('ÉCHOUE quand aucune base n’est configurée', () => {
    // Se déclarer « ignoré » ferait passer une CI sans base pour une CI verte :
    // la dette resterait ouverte en paraissant fermée.
    delete process.env.INTEGRATION_DB_NAME;

    expect(() => reglages()).toThrow(/n’ont pas de base/);
  });

  it('REFUSE une base dont le nom ne dit pas qu’elle est de test', () => {
    process.env.INTEGRATION_DB_NAME = 'websentry';

    expect(() => reglages()).toThrow(/VIDENT les tables/);
  });

  it('accepte une base de test', () => {
    process.env.INTEGRATION_DB_NAME = 'websentry_test';

    expect(reglages().database).toBe('websentry_test');
  });
});
