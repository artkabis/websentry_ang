import { describe, expect, it } from 'vitest';
import { ENV_FILES } from './config.module.js';

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
});
