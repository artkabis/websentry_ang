import { describe, expect, it } from 'vitest';
// @ts-expect-error — script de développement en JavaScript simple, hors du
// programme TypeScript : il s'exécute avant toute compilation.
import { ENV_FILES as ENV_FILES_SCRIPT } from '../../scripts/env-files.mjs';
import { ENV_FILES } from './env-files.js';

describe('emplacement du fichier d’environnement', () => {
  it('cherche à la RACINE du dépôt autant que dans le paquet', () => {
    // Les scripts s'exécutent dans `apps/api` : un `.env` placé à la racine —
    // là où `.env.example` invite à le copier — n'était pas lu, et le
    // démarrage échouait sur « JWT_SECRET manquant » alors qu'il existait.
    expect(ENV_FILES).toContain('.env');
    expect(ENV_FILES).toContain('../../.env');
  });

  it('donne la PRIORITÉ au fichier local du paquet', () => {
    // Un réglage propre à l'API doit pouvoir prendre le pas sur celui du
    // dépôt, jamais l'inverse.
    expect(ENV_FILES.indexOf('.env')).toBeLessThan(ENV_FILES.indexOf('../../.env'));
    expect(ENV_FILES.indexOf('.env.local')).toBeLessThan(ENV_FILES.indexOf('.env'));
  });

  it('reste IDENTIQUE à la liste du script de développement', () => {
    // Le script s'exécute avant toute compilation et ne peut pas importer ce
    // module : il en garde une copie, qui annoncerait des emplacements faux si
    // elle prenait du retard.
    expect(ENV_FILES_SCRIPT).toEqual([...ENV_FILES]);
  });
});
